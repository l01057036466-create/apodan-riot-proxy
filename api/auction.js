// ═══════════════════════════════════════════════════════════════
// 아포단 멸망전 경매 API — bank와 분리된 독립 서버 (같은 Upstash 공유)
// 위치: 저장소 api/auction.js  (bank.js 옆에 둠)
// 필요 환경변수: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (bank와 동일)
// 로그인 세션(sess:TOKEN)을 bank와 공유 → 같은 로그인으로 인증됨
// 관전은 비로그인도 OK · 입찰/운영은 로그인 필요
// ═══════════════════════════════════════════════════════════════
var crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    function cleanEnv(v) { v = String(v || '').trim(); v = v.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '').replace(/^["']+|["']+$/g, ''); return v.trim(); }
    var URL_ = cleanEnv(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, '');
    var TOKEN = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
    if (URL_ && !/^https:\/\//.test(URL_)) URL_ = 'https://' + URL_;
    if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Upstash 환경변수가 없어요' });

    async function redis(cmd) {
      var r = await fetch(URL_ + '/' + cmd.map(encodeURIComponent).join('/'), { headers: { Authorization: 'Bearer ' + TOKEN } });
      var j = await r.json();
      if (j && j.error) throw new Error('Upstash: ' + j.error);
      return j ? j.result : null;
    }
    // bank가 만든 로그인 세션 공유
    async function auth(token) {
      if (!token) return null;
      var v = await redis(['GET', 'sess:' + token]); if (!v) return null;
      if (v === '__dev__') return { role: 'dev', name: '시스템', rank: '' };
      var raw = await redis(['GET', 'acct:' + v]); if (!raw) return { role: 'member', name: v, rank: '' };
      var a; try { a = JSON.parse(raw); } catch (e) { return { role: 'member', name: v, rank: '' }; }
      return { role: a.role || 'member', name: a.name, rank: a.rank || '' };
    }

    var q = req.query || {}, body = req.body || {};
    var action = String(q.action || body.action || '');
    var token = body.token || q.token || '';

    function isOp(s) { return !!(s && (s.role === 'dev' || s.rank === 'chairman')); }
    async function aucGet() { var r = await redis(['GET', 'doom:auc']); return r ? JSON.parse(r) : null; }
    async function aucPut(a) { a.updatedAt = Date.now(); await redis(['SET', 'doom:auc', JSON.stringify(a)]); }
    async function aucBids() { var arr = await redis(['HGETALL', 'doom:auc:bids']); var b = {}; if (Array.isArray(arr)) { for (var i = 0; i < arr.length; i += 2) b[arr[i]] = Number(arr[i + 1]); } else if (arr && typeof arr === 'object') { for (var k in arr) b[k] = Number(arr[k]); } return b; }
    async function aucPasses() { var arr = await redis(['HGETALL', 'doom:auc:passes']); var p = {}; if (Array.isArray(arr)) { for (var i = 0; i < arr.length; i += 2) p[arr[i]] = 1; } else if (arr && typeof arr === 'object') { for (var k in arr) p[k] = 1; } return p; }
    function aucTeam(a, name) { if (a && a.teams && name) for (var i = 0; i < a.teams.length; i++) if (a.teams[i].acct === name) return a.teams[i]; return null; }
    function aucElig(a) { var out = []; if (!a) return out; var tied = (a.phase === 'tie') ? (a.tied || []) : null; for (var i = 0; i < a.teams.length; i++) { var t = a.teams[i]; if (tied && tied.indexOf(t.acct) < 0) continue; if ((t.roster || []).length >= 5) continue; if (t.points < a.prior + a.minBid) continue; out.push(t.acct); } return out; }
    function aucLoadNext(a) { a.prior = 0; a.minBid = 10; a.capOff = false; a.tied = null; a.timer = null; if (!a.queue || !a.queue.length) { a.current = null; a.phase = 'done'; } else { a.current = a.queue.shift(); a.phase = 'bidding'; } }

    var s = await auth(token);

    if (action === 'aucState') { // 관전 = 로그인 불필요
      var a = await aucGet();
      var dOpen = (await redis(['GET', 'doom:open'])) || 'closed';
      if (!a || !a.active) return res.status(200).json({ active: false, open: dOpen, role: isOp(s) ? 'op' : (aucTeam(a, s && s.name) ? 'leader' : 'spectator'), loggedIn: !!(s && s.name) });
      var op = isOp(s), my = aucTeam(a, s && s.name), bids = await aucBids(), elig = aucElig(a), passes = await aucPasses();
      var pub = {
        active: true, phase: a.phase, current: a.current, prior: a.prior, minBid: a.minBid, capOff: a.capOff, loggedIn: !!(s && s.name),
        teams: a.teams.map(function (t) { return { id: t.id, name: t.name, leader: t.leader, color: t.color, points: t.points, roster: t.roster || [], full: (t.roster || []).length >= 5 }; }),
        queueLeft: (a.queue || []).length, lastResult: a.lastResult || null, unsold: a.unsold || [], eligibleCount: elig.length, submittedCount: Object.keys(bids).length, passedCount: Object.keys(passes).length, test: !!a.test, confirmed: !!a.confirmed, open: dOpen, timer: a.timer || null, tiedCount: (a.tied || []).length
      };
      if (op) { pub.role = 'op'; pub.bids = bids; pub.eligible = elig; pub.passed = Object.keys(passes); pub.tied = a.tied || null; pub.acctTeam = {}; a.teams.forEach(function (t) { pub.acctTeam[t.acct] = { id: t.id, name: t.name, color: t.color, leader: t.leader }; }); }
      else if (my) { pub.role = 'leader'; pub.myTeamId = my.id; pub.iEligible = elig.indexOf(s.name) >= 0; pub.iSubmitted = bids[s.name] != null; pub.myBid = (bids[s.name] != null ? bids[s.name] : null); pub.iTied = !!(a.tied && a.tied.indexOf(s.name) >= 0); pub.iPassed = passes[s.name] != null; }
      else pub.role = 'spectator';
      return res.status(200).json(pub);
    }
    if (action === 'aucStart') {
      if (!isOp(s)) return res.status(403).json({ error: '개발자·물방울만 시작할 수 있어요' });
      if (!Array.isArray(body.teams) || !body.teams.length) return res.status(400).json({ error: '팀 정보가 필요해요' });
      if (!Array.isArray(body.queue) || !body.queue.length) return res.status(400).json({ error: '경매 매물이 필요해요' });
      var qST = body.queue.map(function (p) { return { name: String(p.name), position: String(p.position || ''), tier: String(p.tier || ''), cap: (p.cap == null ? 0 : parseInt(p.cap, 10) || 0) }; });
      for (var iST = qST.length - 1; iST > 0; iST--) { var jST = Math.floor(Math.random() * (iST + 1)); var tST = qST[iST]; qST[iST] = qST[jST]; qST[jST] = tST; } // 🎲 순서는 서버에서만 셔플 — 운영자 포함 아무도 다음 매물을 미리 못 봄
      var aST = {
        active: true,
        teams: body.teams.map(function (t, i) { return { id: i, name: String(t.name || ('팀' + (i + 1))), leader: String(t.leader || ''), acct: String(t.acct || ''), color: String(t.color || '#888888'), points: Math.max(0, parseInt(t.points, 10) || 0), roster: [] }; }),
        queue: qST,
        prior: 0, minBid: 10, capOff: false, tied: null, current: null, phase: 'bidding', lastResult: null, unsold: [], startedAt: Date.now(), test: !!body.test
      };
      aucLoadNext(aST); await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aST);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucBid') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요 (지갑에서 로그인)' });
      var aBD = await aucGet(); if (!aBD || !aBD.active) return res.status(400).json({ error: '진행 중인 경매가 없어요' });
      if (aBD.phase !== 'bidding' && aBD.phase !== 'tie') return res.status(400).json({ error: '지금은 입찰 시간이 아니에요' });
      var tBD = aucTeam(aBD, s.name); if (!tBD) return res.status(403).json({ error: '팀장만 입찰할 수 있어요' });
      if (aucElig(aBD).indexOf(s.name) < 0) return res.status(400).json({ error: '이번 매물엔 입찰할 수 없어요 (로스터 마감 또는 포인트 부족)' });
      if (aBD.phase === 'tie' && Array.isArray(aBD.tied) && aBD.tied.indexOf(s.name) < 0) return res.status(400).json({ error: '동점자만 재입찰할 수 있어요' });
      var vBD = parseInt(body.amount, 10);
      if (isNaN(vBD) || vBD < aBD.minBid) return res.status(400).json({ error: '최소 ' + aBD.minBid + 'P 이상이어야 해요' });
      if (vBD % 10 !== 0) return res.status(400).json({ error: '10P 단위로 입력해주세요' });
      if (!aBD.capOff && aBD.current && aBD.current.cap > 0 && vBD > aBD.current.cap) return res.status(400).json({ error: '상한 ' + aBD.current.cap + 'P 초과예요' });
      if (aBD.prior + vBD > tBD.points) return res.status(400).json({ error: '포인트 부족 — 낙찰가 ' + (aBD.prior + vBD) + 'P (잔여 ' + tBD.points + 'P)' });
      await redis(['HSET', 'doom:auc:bids', s.name, String(vBD)]);
      await redis(['HDEL', 'doom:auc:passes', s.name]); // 입찰하면 패스 취소
      return res.status(200).json({ ok: true, bid: vBD, total: aBD.prior + vBD });
    }
    if (action === 'aucUnbid') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      await redis(['HDEL', 'doom:auc:bids', s.name]); return res.status(200).json({ ok: true });
    }
    if (action === 'aucPassBid') { // 🙅 팀장이 이 매물 패스 (입찰 안 함 선언)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var aPB = await aucGet(); if (!aPB || !aPB.active) return res.status(400).json({ error: '경매 없음' });
      if (aPB.phase !== 'bidding') return res.status(400).json({ error: '지금은 패스할 수 없어요' });
      var tPB = aucTeam(aPB, s.name); if (!tPB) return res.status(403).json({ error: '팀장만 패스할 수 있어요' });
      await redis(['HDEL', 'doom:auc:bids', s.name]); await redis(['HSET', 'doom:auc:passes', s.name, '1']);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucReveal') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aRV = await aucGet(); if (!aRV || !aRV.active) return res.status(400).json({ error: '경매 없음' });
      if (aRV.phase !== 'bidding' && aRV.phase !== 'tie') return res.status(400).json({ error: '공개 단계가 아니에요' });
      if (aRV.phase === 'tie' && Array.isArray(aRV.tied) && aRV.tied.length === 1) { // 동점 → 한 명만 남음: 경쟁 없으니 현재가(prior)에 단독 낙찰
        var soloNm = aRV.tied[0], soloT = aucTeam(aRV, soloNm);
        if (soloT && (soloT.roster || []).length < 5 && soloT.points >= aRV.prior) {
          soloT.points -= aRV.prior; soloT.roster.push({ name: aRV.current.name, cost: aRV.prior, position: aRV.current.position, tier: aRV.current.tier, cap: aRV.current.cap });
          aRV.lastResult = { player: aRV.current.name, position: aRV.current.position, winner: soloT.name, leader: soloT.leader, color: soloT.color, cost: aRV.prior, prior: aRV.prior, bid: 0, n: 1, sole: true };
          aRV.phase = 'revealed'; aRV.tied = null; aRV.timer = null;
          await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aRV);
          return res.status(200).json({ ok: true, result: 'sold', winner: soloT.name, cost: aRV.prior, sole: true });
        }
      }
      var bRV = await aucBids(), eRV = aucElig(aRV), valid = [];
      for (var kRV in bRV) if (eRV.indexOf(kRV) >= 0) valid.push({ acct: kRV, bid: bRV[kRV] });
      if (!valid.length) return res.status(200).json({ ok: true, result: 'none' });
      var maxRV = 0; for (var i = 0; i < valid.length; i++) if (valid[i].bid > maxRV) maxRV = valid[i].bid;
      var winRV = valid.filter(function (x) { return x.bid === maxRV; });
      if (winRV.length === 1) {
        var wT = aucTeam(aRV, winRV[0].acct), cost = aRV.prior + maxRV;
        wT.points -= cost; wT.roster.push({ name: aRV.current.name, cost: cost, position: aRV.current.position, tier: aRV.current.tier, cap: aRV.current.cap });
        aRV.lastResult = { player: aRV.current.name, position: aRV.current.position, winner: wT.name, leader: wT.leader, color: wT.color, cost: cost, prior: aRV.prior, bid: maxRV, n: valid.length };
        aRV.phase = 'revealed'; aRV.timer = null; await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aRV);
        return res.status(200).json({ ok: true, result: 'sold', winner: wT.name, cost: cost });
      }
      aRV.prior = aRV.prior + maxRV; aRV.minBid = maxRV + 10; aRV.capOff = true; aRV.tied = winRV.map(function (x) { return x.acct; }); aRV.phase = 'tie'; aRV.timer = null;
      await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aRV);
      return res.status(200).json({ ok: true, result: 'tie', tied: aRV.tied.length, prior: aRV.prior, minBid: aRV.minBid });
    }
    if (action === 'aucGiveUp') { // 🏳️ 동점 재입찰 중 포기 선언
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var aGU = await aucGet(); if (!aGU || !aGU.active) return res.status(400).json({ error: '경매 없음' });
      if (aGU.phase !== 'tie') return res.status(400).json({ error: '동점 재입찰 중에만 포기할 수 있어요' });
      if (!Array.isArray(aGU.tied) || aGU.tied.indexOf(s.name) < 0) return res.status(403).json({ error: '동점자만 포기할 수 있어요' });
      aGU.tied = aGU.tied.filter(function (x) { return x !== s.name; });
      await redis(['HDEL', 'doom:auc:bids', s.name]);
      if (aGU.tied.length === 0) { // 전원 포기 → 유찰
        aGU.unsold = aGU.unsold || []; aGU.unsold.push({ name: aGU.current.name, position: aGU.current.position, tier: aGU.current.tier, cap: aGU.current.cap });
        aGU.lastResult = { player: aGU.current.name, passed: true, allGaveUp: true };
        aGU.phase = 'revealed'; aGU.tied = null; aGU.timer = null;
        await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aGU);
        return res.status(200).json({ ok: true, result: 'none', allGaveUp: true });
      }
      await aucPut(aGU); // 1명 이상 남음 → 공개(낙찰) 때 정산 (한 명이면 현재가 단독 낙찰)
      return res.status(200).json({ ok: true, result: 'continue', remaining: aGU.tied.length });
    }

    if (action === 'aucNext') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aNX = await aucGet(); if (!aNX || !aNX.active) return res.status(400).json({ error: '경매 없음' });
      aucLoadNext(aNX); await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aNX);
      return res.status(200).json({ ok: true, phase: aNX.phase });
    }
    if (action === 'aucPass') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aPS = await aucGet(); if (!aPS || !aPS.active) return res.status(400).json({ error: '경매 없음' });
      if (aPS.current) { aPS.unsold.push({ name: aPS.current.name, position: aPS.current.position, tier: aPS.current.tier, cap: aPS.current.cap }); aPS.lastResult = { player: aPS.current.name, passed: true }; }
      aucLoadNext(aPS); await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aPS);
      return res.status(200).json({ ok: true, phase: aPS.phase });
    }
    if (action === 'aucRequeueUnsold') { // 🔁 유찰자 전원을 다시 경매 대기열로 (한 바퀴 돌고 재도전)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aRU = await aucGet(); if (!aRU || !aRU.active) return res.status(400).json({ error: '경매 없음' });
      var usRU = aRU.unsold || []; if (!usRU.length) return res.status(400).json({ error: '유찰된 선수가 없어요' });
      var backRU = usRU.map(function (u) { return (typeof u === 'string') ? { name: u, position: '', tier: '', cap: 0 } : { name: u.name, position: u.position || '', tier: u.tier || '', cap: (u.cap == null ? 0 : u.cap) }; });
      for (var iRU = backRU.length - 1; iRU > 0; iRU--) { var jRU = Math.floor(Math.random() * (iRU + 1)); var tRU = backRU[iRU]; backRU[iRU] = backRU[jRU]; backRU[jRU] = tRU; } // 다시 셔플
      aRU.queue = (aRU.queue || []).concat(backRU); aRU.unsold = [];
      if (aRU.phase === 'done' || !aRU.current) { aRU.active = true; aRU.confirmed = false; aucLoadNext(aRU); } // 끝났으면 다시 진행
      await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aRU);
      return res.status(200).json({ ok: true, requeued: backRU.length, queueLeft: aRU.queue.length });
    }
    if (action === 'aucTimer') { // ⏱ 운영자 타이머 시작 (discuss=토론 / bid=영입제출)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTM = await aucGet(); if (!aTM || !aTM.active) return res.status(400).json({ error: '경매 없음' });
      var kindTM = (body.kind === 'bid') ? 'bid' : 'discuss';
      var secTM = Math.max(1, Math.min(3600, parseInt(body.seconds, 10) || (kindTM === 'bid' ? 10 : 60)));
      aTM.timer = { kind: kindTM, endsAt: Date.now() + secTM * 1000, dur: secTM };
      await aucPut(aTM);
      return res.status(200).json({ ok: true, timer: aTM.timer });
    }
    if (action === 'aucTimerAdjust') { // ⏱ 타이머 정정 (+/- 초)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTA = await aucGet(); if (!aTA || !aTA.active || !aTA.timer) return res.status(400).json({ error: '진행 중인 타이머가 없어요' });
      var dTA = parseInt(body.delta, 10) || 0;
      aTA.timer.endsAt = Math.max(Date.now(), (aTA.timer.endsAt || Date.now()) + dTA * 1000);
      await aucPut(aTA);
      return res.status(200).json({ ok: true, timer: aTA.timer });
    }
    if (action === 'aucTimerClear') { // ⏹ 타이머 정지
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTC = await aucGet(); if (!aTC || !aTC.active) return res.status(400).json({ error: '경매 없음' });
      aTC.timer = null; await aucPut(aTC);
      return res.status(200).json({ ok: true });
    }
    // ===== 📅 경기 일정 + 🙋 대타 구인 =====
    if (action === 'aucSchedList') {
      var schedL = []; try { schedL = JSON.parse((await redis(['GET', 'doom:sched'])) || '[]'); } catch (e) { schedL = []; }
      var recruitL = []; try { recruitL = JSON.parse((await redis(['GET', 'doom:recruit'])) || '[]'); } catch (e) { recruitL = []; }
      var lockedT = []; try { lockedT = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lockedT = []; }
      var availL = []; try { availL = JSON.parse((await redis(['GET', 'doom:avail'])) || '[]'); } catch (e) { availL = []; }
      var resultsL = []; try { resultsL = JSON.parse((await redis(['GET', 'doom:results'])) || '[]'); } catch (e) { resultsL = []; }
      var pubT = lockedT.map(function (t) { return { acct: t.acct, name: t.name, leader: t.leader, color: t.color, points: t.points, roster: t.roster || [] }; });
      var myAcctS = (s && s.name) || '', mySchedS = null, myPracticeS = [], allSchedS = null, allPracticeS = null, opSchedS = isOp(s);
      if (opSchedS) { allSchedS = {}; allPracticeS = {}; }
      lockedT.forEach(function (t) { if (t.acct === myAcctS) { mySchedS = t.sched || ''; myPracticeS = t.practice || []; } if (opSchedS) { allSchedS[t.acct] = t.sched || ''; allPracticeS[t.acct] = t.practice || []; } });
      return res.status(200).json({ ok: true, sched: schedL, recruit: recruitL, teams: pubT, myAcct: myAcctS, mySched: mySchedS, allSched: allSchedS, allPractice: allPracticeS, avail: availL, results: resultsL, myPractice: myPracticeS });
    }
    if (action === 'aucSchedAdd') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요 (지갑에서 로그인)' });
      var schA = []; try { schA = JSON.parse((await redis(['GET', 'doom:sched'])) || '[]'); } catch (e) { schA = []; }
      var typeA = ['available', 'scrim', 'match'].indexOf(body.type) >= 0 ? body.type : 'available';
      var dateA = String(body.date || '').slice(0, 10);
      if (!dateA) return res.status(400).json({ error: '날짜를 선택해주세요' });
      var entA = { id: 'S' + Date.now().toString(36) + Math.floor(Math.random() * 1000), type: typeA, teamName: String(body.teamName || '').slice(0, 40), opponent: String(body.opponent || '').slice(0, 40), date: dateA, time: String(body.time || '').slice(0, 5), note: String(body.note || '').slice(0, 120), by: s.name, at: Date.now() };
      schA.push(entA); if (schA.length > 300) schA = schA.slice(-300);
      await redis(['SET', 'doom:sched', JSON.stringify(schA)]);
      return res.status(200).json({ ok: true, entry: entA });
    }
    if (action === 'aucSchedDel') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var schD = []; try { schD = JSON.parse((await redis(['GET', 'doom:sched'])) || '[]'); } catch (e) { schD = []; }
      var tgtD = schD.filter(function (x) { return x.id === body.id; })[0];
      if (!tgtD) return res.status(404).json({ error: '항목을 찾을 수 없어요' });
      if (tgtD.by !== s.name && !isOp(s)) return res.status(403).json({ error: '본인이 등록한 항목만 지울 수 있어요' });
      schD = schD.filter(function (x) { return x.id !== body.id; });
      await redis(['SET', 'doom:sched', JSON.stringify(schD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucRecruitAdd') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요 (지갑에서 로그인)' });
      var recA = []; try { recA = JSON.parse((await redis(['GET', 'doom:recruit'])) || '[]'); } catch (e) { recA = []; }
      var kindA = (body.kind === 'practice') ? 'practice' : 'scrim';
      var postA = { id: 'R' + Date.now().toString(36) + Math.floor(Math.random() * 1000), teamName: String(body.teamName || '').slice(0, 40), kind: kindA, position: String(body.position || '').slice(0, 20), when: String(body.when || '').slice(0, 40), note: String(body.note || '').slice(0, 120), by: s.name, status: 'open', at: Date.now() };
      recA.unshift(postA); if (recA.length > 200) recA = recA.slice(0, 200);
      await redis(['SET', 'doom:recruit', JSON.stringify(recA)]);
      return res.status(200).json({ ok: true, post: postA });
    }
    if (action === 'aucRecruitDel') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var recD = []; try { recD = JSON.parse((await redis(['GET', 'doom:recruit'])) || '[]'); } catch (e) { recD = []; }
      var tgtRD = recD.filter(function (x) { return x.id === body.id; })[0];
      if (!tgtRD) return res.status(404).json({ error: '글을 찾을 수 없어요' });
      if (tgtRD.by !== s.name && !isOp(s)) return res.status(403).json({ error: '본인 글만 지울 수 있어요' });
      recD = recD.filter(function (x) { return x.id !== body.id; });
      await redis(['SET', 'doom:recruit', JSON.stringify(recD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucRecruitToggle') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var recT = []; try { recT = JSON.parse((await redis(['GET', 'doom:recruit'])) || '[]'); } catch (e) { recT = []; }
      var tgtT = recT.filter(function (x) { return x.id === body.id; })[0];
      if (!tgtT) return res.status(404).json({ error: '글을 찾을 수 없어요' });
      if (tgtT.by !== s.name && !isOp(s)) return res.status(403).json({ error: '본인 글만 수정할 수 있어요' });
      tgtT.status = (tgtT.status === 'open') ? 'closed' : 'open';
      await redis(['SET', 'doom:recruit', JSON.stringify(recT)]);
      return res.status(200).json({ ok: true, status: tgtT.status });
    }

    if (action === 'aucTestBid') { // 🧪 운영자가 특정 팀 대신 입찰 (테스트 모드 전용)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTB = await aucGet(); if (!aTB || !aTB.active) return res.status(400).json({ error: '경매 없음' });
      if (!aTB.test) return res.status(403).json({ error: '테스트 모드에서만 대리 입찰돼요' });
      if (aTB.phase !== 'bidding' && aTB.phase !== 'tie') return res.status(400).json({ error: '입찰 단계가 아니에요' });
      var accTB = String(body.acct || ''); var tTB = aucTeam(aTB, accTB); if (!tTB) return res.status(400).json({ error: '없는 팀' });
      if (aucElig(aTB).indexOf(accTB) < 0) return res.status(400).json({ error: (tTB.name || accTB) + '은(는) 이번 매물에 입찰 불가' });
      var vTB = parseInt(body.amount, 10);
      if (isNaN(vTB) || vTB < aTB.minBid) return res.status(400).json({ error: '최소 ' + aTB.minBid + 'P 이상' });
      if (vTB % 10 !== 0) return res.status(400).json({ error: '10P 단위' });
      if (!aTB.capOff && aTB.current && aTB.current.cap > 0 && vTB > aTB.current.cap) return res.status(400).json({ error: '상한 ' + aTB.current.cap + 'P 초과' });
      if (aTB.prior + vTB > tTB.points) return res.status(400).json({ error: '포인트 부족' });
      await redis(['HSET', 'doom:auc:bids', accTB, String(vTB)]);
      return res.status(200).json({ ok: true, acct: accTB, bid: vTB });
    }
    if (action === 'aucTestFill') { // 🎲 입찰가능 팀 전원 랜덤 입찰 (테스트 모드 전용)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTF = await aucGet(); if (!aTF || !aTF.active) return res.status(400).json({ error: '경매 없음' });
      if (!aTF.test) return res.status(403).json({ error: '테스트 모드 전용' });
      if (aTF.phase !== 'bidding' && aTF.phase !== 'tie') return res.status(400).json({ error: '입찰 단계가 아니에요' });
      var eligTF = aucElig(aTF), capTF = (!aTF.capOff && aTF.current && aTF.current.cap > 0) ? aTF.current.cap : 0, filled = [];
      for (var i = 0; i < eligTF.length; i++) {
        var tF = aucTeam(aTF, eligTF[i]); var hi = tF.points - aTF.prior; if (capTF > 0) hi = Math.min(hi, capTF);
        if (hi < aTF.minBid) continue;
        var steps = Math.floor((hi - aTF.minBid) / 10); var bidF = aTF.minBid + (steps > 0 ? Math.floor(Math.random() * (steps + 1)) * 10 : 0);
        await redis(['HSET', 'doom:auc:bids', eligTF[i], String(bidF)]); filled.push({ team: tF.name, bid: bidF });
      }
      return res.status(200).json({ ok: true, filled: filled });
    }
    if (action === 'aucTestUnbid') { // 🧪 운영자가 특정 팀 입찰 취소 (테스트 모드 전용)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aTU = await aucGet(); if (!aTU || !aTU.active) return res.status(400).json({ error: '경매 없음' });
      if (!aTU.test) return res.status(403).json({ error: '테스트 모드 전용' });
      await redis(['HDEL', 'doom:auc:bids', String(body.acct || '')]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucRemovePlayer') { // 운영 — 선수 한 명 빼기(환불) · 선택시 재경매 대기열로
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aRP = await aucGet(); if (!aRP || !aRP.active) return res.status(400).json({ error: '경매 없음' });
      var tidRP = parseInt(body.teamId, 10); var nmRP = String(body.name || '');
      var tRP = null; for (var i = 0; i < aRP.teams.length; i++) if (aRP.teams[i].id === tidRP) tRP = aRP.teams[i];
      if (!tRP) return res.status(400).json({ error: '없는 팀' });
      var idxRP = -1; for (var j = 0; j < (tRP.roster || []).length; j++) if (tRP.roster[j].name === nmRP) { idxRP = j; break; }
      if (idxRP < 0) return res.status(400).json({ error: '그 선수가 이 팀 로스터에 없어요' });
      var remRP = tRP.roster.splice(idxRP, 1)[0];
      tRP.points += (remRP.cost || 0); // 환불
      if (body.requeue) aRP.queue.push({ name: remRP.name, position: remRP.position || '', tier: remRP.tier || '', cap: (remRP.cap == null ? 0 : remRP.cap) });
      if (aRP.phase === 'done' && body.requeue) { aRP.active = true; if (!aRP.current) aucLoadNext(aRP); } // 확정 후 재경매면 다시 진행
      await aucPut(aRP);
      return res.status(200).json({ ok: true, refunded: (remRP.cost || 0), requeued: !!body.requeue });
    }
    if (action === 'aucClearTeam') { // 운영 — 팀 로스터 전부 비우기(환불)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aCT = await aucGet(); if (!aCT || !aCT.active) return res.status(400).json({ error: '경매 없음' });
      var tidCT = parseInt(body.teamId, 10); var tCT = null;
      for (var i = 0; i < aCT.teams.length; i++) if (aCT.teams[i].id === tidCT) tCT = aCT.teams[i];
      if (!tCT) return res.status(400).json({ error: '없는 팀' });
      var refCT = 0; (tCT.roster || []).forEach(function (r) { refCT += (r.cost || 0); });
      tCT.points += refCT; tCT.roster = [];
      await aucPut(aCT);
      return res.status(200).json({ ok: true, refunded: refCT });
    }
    if (action === 'aucSetPosition') { // 🎯 로스터 선수 포지션 확정 (팀장/운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var plPos = String(body.player || '').trim(); if (!plPos) return res.status(400).json({ error: '선수를 지정해주세요' });
      var posPos = String(body.position || '').slice(0, 10);
      var lkPos = []; try { lkPos = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkPos = []; }
      if (!lkPos.length) return res.status(400).json({ error: '먼저 팀 명단을 확정해주세요' });
      var tgtPos = (isOp(s) && body.acct) ? String(body.acct) : s.name, foundPos = false;
      lkPos.forEach(function (t) { if (t.acct === tgtPos) { (t.roster || []).forEach(function (r) { if (r.name === plPos) { r.position = posPos; foundPos = true; } }); } });
      if (!foundPos) return res.status(404).json({ error: '선수를 찾을 수 없거나 권한이 없어요' });
      await redis(['SET', 'doom:teams', JSON.stringify(lkPos)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucTeamPracAdd') { // 📅 비공개 팀 연습 날짜 추가 (팀장/운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var dtP = String(body.date || '').slice(0, 10); if (!dtP) return res.status(400).json({ error: '날짜를 선택해주세요' });
      var lkP = []; try { lkP = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkP = []; }
      if (!lkP.length) return res.status(400).json({ error: '먼저 팀 명단을 확정해주세요' });
      var tgtP = (isOp(s) && body.acct) ? String(body.acct) : s.name, foundP = false;
      lkP.forEach(function (t) { if (t.acct === tgtP) { if (!Array.isArray(t.practice)) t.practice = []; t.practice.push({ id: 'tp' + Date.now() + Math.floor(Math.random() * 1000), date: dtP, note: String(body.note || '').slice(0, 80) }); foundP = true; } });
      if (!foundP) return res.status(403).json({ error: '본인 팀만 쓸 수 있어요' });
      await redis(['SET', 'doom:teams', JSON.stringify(lkP)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucTeamPracDel') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var lkPD = []; try { lkPD = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkPD = []; }
      var tgtPD = (isOp(s) && body.acct) ? String(body.acct) : s.name;
      lkPD.forEach(function (t) { if (t.acct === tgtPD && Array.isArray(t.practice)) t.practice = t.practice.filter(function (x) { return x.id !== body.id; }); });
      await redis(['SET', 'doom:teams', JSON.stringify(lkPD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucResultAdd') { // 🏆 경기 결과 기록 (운영)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aN = String(body.aName || '').trim(), bN = String(body.bName || '').trim();
      if (!aN || !bN) return res.status(400).json({ error: '두 팀을 선택해주세요' });
      if (aN === bN) return res.status(400).json({ error: '같은 팀끼리는 안 돼요' });
      var sA = parseInt(body.scoreA, 10), sB = parseInt(body.scoreB, 10);
      if (isNaN(sA) || isNaN(sB) || sA < 0 || sB < 0) return res.status(400).json({ error: '점수를 입력해주세요' });
      var lkR = []; try { lkR = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkR = []; }
      var colOf = {}; lkR.forEach(function (t) { colOf[t.name] = t.color; });
      var resR = []; try { resR = JSON.parse((await redis(['GET', 'doom:results'])) || '[]'); } catch (e) { resR = []; }
      resR.push({ id: 'r' + Date.now() + Math.floor(Math.random() * 1000), date: String(body.date || '').slice(0, 10), aName: aN, aColor: colOf[aN] || '', bName: bN, bColor: colOf[bN] || '', scoreA: sA, scoreB: sB, round: String(body.round || '').slice(0, 30), note: String(body.note || '').slice(0, 100), at: Date.now() });
      await redis(['SET', 'doom:results', JSON.stringify(resR)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucResultDel') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var resD = []; try { resD = JSON.parse((await redis(['GET', 'doom:results'])) || '[]'); } catch (e) { resD = []; }
      resD = resD.filter(function (x) { return x.id !== body.id; });
      await redis(['SET', 'doom:results', JSON.stringify(resD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucAvailAdd') { // 🟢 연습 가능 날짜 등록 (로그인 누구나)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var dtAv = String(body.date || '').slice(0, 10); if (!dtAv) return res.status(400).json({ error: '날짜를 선택해주세요' });
      var avA = []; try { avA = JSON.parse((await redis(['GET', 'doom:avail'])) || '[]'); } catch (e) { avA = []; }
      if (avA.some(function (x) { return x.by === s.name && x.date === dtAv; })) return res.status(400).json({ error: '이미 등록한 날짜예요' });
      var lkAv = []; try { lkAv = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkAv = []; }
      var myTeamAv = null;
      lkAv.forEach(function (t) { if (t.acct === s.name) myTeamAv = t; (t.roster || []).forEach(function (r) { if (r.name === s.name) myTeamAv = t; }); });
      avA.push({ id: 'av' + Date.now() + Math.floor(Math.random() * 1000), date: dtAv, by: s.name, teamName: myTeamAv ? myTeamAv.name : '', color: myTeamAv ? myTeamAv.color : '', note: String(body.note || '').slice(0, 80), at: Date.now() });
      await redis(['SET', 'doom:avail', JSON.stringify(avA)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucAvailDel') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var avD = []; try { avD = JSON.parse((await redis(['GET', 'doom:avail'])) || '[]'); } catch (e) { avD = []; }
      var opAvD = isOp(s);
      avD = avD.filter(function (x) { return !(x.id === body.id && (x.by === s.name || opAvD)); });
      await redis(['SET', 'doom:avail', JSON.stringify(avD)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucLockTeams') { // 🔒 현재 로스터를 영구 확정(못 박기)
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aLK = await aucGet(); if (!aLK || !aLK.teams || !aLK.teams.length) return res.status(400).json({ error: '확정할 팀이 없어요' });
      var prevLK = []; try { prevLK = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { prevLK = []; }
      var prevByA = {}; prevLK.forEach(function (t) { prevByA[t.acct] = t; });
      var locked = aLK.teams.map(function (t) { var p = prevByA[t.acct] || {}; return { acct: t.acct, name: p.name || t.name, leader: t.leader, color: t.color, points: t.points, roster: (t.roster || []).map(function (r) { return { name: r.name, cost: r.cost, position: r.position, tier: r.tier }; }), sched: p.sched || '', practice: p.practice || [] }; });
      await redis(['SET', 'doom:teams', JSON.stringify(locked)]);
      aLK.phase = 'done'; aLK.confirmed = true; aLK.queue = []; aLK.current = null;
      await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aLK);
      return res.status(200).json({ ok: true, teams: locked.length });
    }
    if (action === 'aucSetTeamName') { // ✏️ 팀명 변경 (팀장 본인 or 운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var nmN = String(body.name || '').trim().slice(0, 20); if (!nmN) return res.status(400).json({ error: '팀명을 입력해주세요' });
      var lkN = []; try { lkN = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkN = []; }
      if (!lkN.length) return res.status(400).json({ error: '먼저 팀 명단을 확정(못 박기)해주세요' });
      var tgtN = (isOp(s) && body.acct) ? String(body.acct) : s.name, foundN = false;
      lkN.forEach(function (t) { if (t.acct === tgtN) { t.name = nmN; foundN = true; } });
      if (!foundN) return res.status(403).json({ error: '본인 팀만 바꿀 수 있어요' });
      await redis(['SET', 'doom:teams', JSON.stringify(lkN)]);
      return res.status(200).json({ ok: true, name: nmN });
    }
    if (action === 'aucSetTeamSched') { // 📋 팀 비공개 일정 메모 (팀장 본인 or 운영)
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var txtS = String(body.sched || '').slice(0, 1500);
      var lkS = []; try { lkS = JSON.parse((await redis(['GET', 'doom:teams'])) || '[]'); } catch (e) { lkS = []; }
      if (!lkS.length) return res.status(400).json({ error: '먼저 팀 명단을 확정해주세요' });
      var tgtS = (isOp(s) && body.acct) ? String(body.acct) : s.name, foundS = false;
      lkS.forEach(function (t) { if (t.acct === tgtS) { t.sched = txtS; foundS = true; } });
      if (!foundS) return res.status(403).json({ error: '본인 팀만 쓸 수 있어요' });
      await redis(['SET', 'doom:teams', JSON.stringify(lkS)]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucFinalize') { // 운영 — 현재 로스터로 확정·종료
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aFN = await aucGet(); if (!aFN || !aFN.active) return res.status(400).json({ error: '경매 없음' });
      aFN.phase = 'done'; aFN.confirmed = true; aFN.queue = []; aFN.current = null;
      await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); await aucPut(aFN);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucPublish') { // 운영 — 멸망전 페이지를 다른 팀장·관전자에게 공개/숨김
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      await redis(['SET', 'doom:open', String(body.level || 'closed')]);
      return res.status(200).json({ ok: true, open: String(body.level || 'closed') });
    }
    if (action === 'aucReset') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      await redis(['DEL', 'doom:auc']); await redis(['DEL', 'doom:auc:bids']); await redis(['DEL', 'doom:auc:passes']); return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '알 수 없는 요청: ' + action });
  } catch (e) {
    return res.status(500).json({ error: '경매 서버 오류: ' + (e && e.message ? e.message : String(e)) });
  }
};
