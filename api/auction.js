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
    function aucTeam(a, name) { if (a && a.teams && name) for (var i = 0; i < a.teams.length; i++) if (a.teams[i].acct === name) return a.teams[i]; return null; }
    function aucElig(a) { var out = []; if (!a) return out; var tied = (a.phase === 'tie') ? (a.tied || []) : null; for (var i = 0; i < a.teams.length; i++) { var t = a.teams[i]; if (tied && tied.indexOf(t.acct) < 0) continue; if ((t.roster || []).length >= 5) continue; if (t.points < a.prior + a.minBid) continue; out.push(t.acct); } return out; }
    function aucLoadNext(a) { a.prior = 0; a.minBid = 10; a.capOff = false; a.tied = null; if (!a.queue || !a.queue.length) { a.current = null; a.phase = 'done'; } else { a.current = a.queue.shift(); a.phase = 'bidding'; } }

    var s = await auth(token);

    if (action === 'aucState') { // 관전 = 로그인 불필요
      var a = await aucGet();
      var dOpen = (await redis(['GET', 'doom:open'])) || 'closed';
      if (!a || !a.active) return res.status(200).json({ active: false, open: dOpen, role: isOp(s) ? 'op' : (aucTeam(a, s && s.name) ? 'leader' : 'spectator'), loggedIn: !!(s && s.name) });
      var op = isOp(s), my = aucTeam(a, s && s.name), bids = await aucBids(), elig = aucElig(a);
      var pub = {
        active: true, phase: a.phase, current: a.current, prior: a.prior, minBid: a.minBid, capOff: a.capOff, loggedIn: !!(s && s.name),
        teams: a.teams.map(function (t) { return { id: t.id, name: t.name, leader: t.leader, color: t.color, points: t.points, roster: t.roster || [], full: (t.roster || []).length >= 5 }; }),
        queueLeft: (a.queue || []).length, lastResult: a.lastResult || null, unsold: a.unsold || [], eligibleCount: elig.length, submittedCount: Object.keys(bids).length, test: !!a.test, confirmed: !!a.confirmed, open: dOpen
      };
      if (op) { pub.role = 'op'; pub.bids = bids; pub.eligible = elig; pub.acctTeam = {}; a.teams.forEach(function (t) { pub.acctTeam[t.acct] = { id: t.id, name: t.name, color: t.color, leader: t.leader }; }); }
      else if (my) { pub.role = 'leader'; pub.myTeamId = my.id; pub.iEligible = elig.indexOf(s.name) >= 0; pub.iSubmitted = bids[s.name] != null; pub.myBid = (bids[s.name] != null ? bids[s.name] : null); }
      else pub.role = 'spectator';
      return res.status(200).json(pub);
    }
    if (action === 'aucStart') {
      if (!isOp(s)) return res.status(403).json({ error: '개발자·물방울만 시작할 수 있어요' });
      if (!Array.isArray(body.teams) || !body.teams.length) return res.status(400).json({ error: '팀 정보가 필요해요' });
      if (!Array.isArray(body.queue) || !body.queue.length) return res.status(400).json({ error: '경매 매물이 필요해요' });
      var aST = {
        active: true,
        teams: body.teams.map(function (t, i) { return { id: i, name: String(t.name || ('팀' + (i + 1))), leader: String(t.leader || ''), acct: String(t.acct || ''), color: String(t.color || '#888888'), points: Math.max(0, parseInt(t.points, 10) || 0), roster: [] }; }),
        queue: body.queue.map(function (p) { return { name: String(p.name), position: String(p.position || ''), tier: String(p.tier || ''), cap: (p.cap == null ? 0 : parseInt(p.cap, 10) || 0) }; }),
        prior: 0, minBid: 10, capOff: false, tied: null, current: null, phase: 'bidding', lastResult: null, unsold: [], startedAt: Date.now(), test: !!body.test
      };
      aucLoadNext(aST); await redis(['DEL', 'doom:auc:bids']); await aucPut(aST);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucBid') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요 (지갑에서 로그인)' });
      var aBD = await aucGet(); if (!aBD || !aBD.active) return res.status(400).json({ error: '진행 중인 경매가 없어요' });
      if (aBD.phase !== 'bidding' && aBD.phase !== 'tie') return res.status(400).json({ error: '지금은 입찰 시간이 아니에요' });
      var tBD = aucTeam(aBD, s.name); if (!tBD) return res.status(403).json({ error: '팀장만 입찰할 수 있어요' });
      if (aucElig(aBD).indexOf(s.name) < 0) return res.status(400).json({ error: '이번 매물엔 입찰할 수 없어요 (로스터 마감 또는 포인트 부족)' });
      var vBD = parseInt(body.amount, 10);
      if (isNaN(vBD) || vBD < aBD.minBid) return res.status(400).json({ error: '최소 ' + aBD.minBid + 'P 이상이어야 해요' });
      if (vBD % 10 !== 0) return res.status(400).json({ error: '10P 단위로 입력해주세요' });
      if (!aBD.capOff && aBD.current && aBD.current.cap > 0 && vBD > aBD.current.cap) return res.status(400).json({ error: '상한 ' + aBD.current.cap + 'P 초과예요' });
      if (aBD.prior + vBD > tBD.points) return res.status(400).json({ error: '포인트 부족 — 낙찰가 ' + (aBD.prior + vBD) + 'P (잔여 ' + tBD.points + 'P)' });
      await redis(['HSET', 'doom:auc:bids', s.name, String(vBD)]);
      return res.status(200).json({ ok: true, bid: vBD, total: aBD.prior + vBD });
    }
    if (action === 'aucUnbid') {
      if (!s || !s.name) return res.status(401).json({ error: '로그인이 필요해요' });
      await redis(['HDEL', 'doom:auc:bids', s.name]); return res.status(200).json({ ok: true });
    }
    if (action === 'aucReveal') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aRV = await aucGet(); if (!aRV || !aRV.active) return res.status(400).json({ error: '경매 없음' });
      if (aRV.phase !== 'bidding' && aRV.phase !== 'tie') return res.status(400).json({ error: '공개 단계가 아니에요' });
      var bRV = await aucBids(), eRV = aucElig(aRV), valid = [];
      for (var kRV in bRV) if (eRV.indexOf(kRV) >= 0) valid.push({ acct: kRV, bid: bRV[kRV] });
      if (!valid.length) return res.status(200).json({ ok: true, result: 'none' });
      var maxRV = 0; for (var i = 0; i < valid.length; i++) if (valid[i].bid > maxRV) maxRV = valid[i].bid;
      var winRV = valid.filter(function (x) { return x.bid === maxRV; });
      if (winRV.length === 1) {
        var wT = aucTeam(aRV, winRV[0].acct), cost = aRV.prior + maxRV;
        wT.points -= cost; wT.roster.push({ name: aRV.current.name, cost: cost, position: aRV.current.position, tier: aRV.current.tier, cap: aRV.current.cap });
        aRV.lastResult = { player: aRV.current.name, position: aRV.current.position, winner: wT.name, leader: wT.leader, color: wT.color, cost: cost, prior: aRV.prior, bid: maxRV, n: valid.length };
        aRV.phase = 'revealed'; await redis(['DEL', 'doom:auc:bids']); await aucPut(aRV);
        return res.status(200).json({ ok: true, result: 'sold', winner: wT.name, cost: cost });
      }
      aRV.prior = aRV.prior + maxRV; aRV.minBid = maxRV + 10; aRV.capOff = true; aRV.tied = winRV.map(function (x) { return x.acct; }); aRV.phase = 'tie';
      await redis(['DEL', 'doom:auc:bids']); await aucPut(aRV);
      return res.status(200).json({ ok: true, result: 'tie', tied: aRV.tied.length, prior: aRV.prior, minBid: aRV.minBid });
    }
    if (action === 'aucNext') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aNX = await aucGet(); if (!aNX || !aNX.active) return res.status(400).json({ error: '경매 없음' });
      aucLoadNext(aNX); await redis(['DEL', 'doom:auc:bids']); await aucPut(aNX);
      return res.status(200).json({ ok: true, phase: aNX.phase });
    }
    if (action === 'aucPass') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aPS = await aucGet(); if (!aPS || !aPS.active) return res.status(400).json({ error: '경매 없음' });
      if (aPS.current) { aPS.unsold.push(aPS.current.name); aPS.lastResult = { player: aPS.current.name, passed: true }; }
      aucLoadNext(aPS); await redis(['DEL', 'doom:auc:bids']); await aucPut(aPS);
      return res.status(200).json({ ok: true, phase: aPS.phase });
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
    if (action === 'aucFinalize') { // 운영 — 현재 로스터로 확정·종료
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      var aFN = await aucGet(); if (!aFN || !aFN.active) return res.status(400).json({ error: '경매 없음' });
      aFN.phase = 'done'; aFN.confirmed = true; aFN.queue = []; aFN.current = null;
      await redis(['DEL', 'doom:auc:bids']); await aucPut(aFN);
      return res.status(200).json({ ok: true });
    }
    if (action === 'aucPublish') { // 운영 — 멸망전 페이지를 다른 팀장·관전자에게 공개/숨김
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      await redis(['SET', 'doom:open', String(body.level || 'closed')]);
      return res.status(200).json({ ok: true, open: String(body.level || 'closed') });
    }
    if (action === 'aucReset') {
      if (!isOp(s)) return res.status(403).json({ error: '권한 없음' });
      await redis(['DEL', 'doom:auc']); await redis(['DEL', 'doom:auc:bids']); return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '알 수 없는 요청: ' + action });
  } catch (e) {
    return res.status(500).json({ error: '경매 서버 오류: ' + (e && e.message ? e.message : String(e)) });
  }
};
