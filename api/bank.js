// ═══════════════════════════════════════════════════════════════
// 아포단 거래소(APEX) 은행 API — v3: 계정·베팅 + 멤버 주식 거래소 + 내전 참여 수당
// 위치: 저장소 api/bank.js  (vote.js 옆)
// 필요 환경변수: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
//               BANK_DEV_CODE  ← 개발자 마스터 코드 (주형만 아는 비밀번호, 새로 추가!)
// 권한: dev(유령 세션, 목록에 안 나옴) > admin > member
// ═══════════════════════════════════════════════════════════════
var crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    function cleanEnv(v) {
      v = String(v || '').trim();
      v = v.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, '').replace(/^["']+|["']+$/g, '');
      return v.trim();
    }
    var URL_ = cleanEnv(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, '');
    var TOKEN = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
    var DEV_CODE = cleanEnv(process.env.BANK_DEV_CODE);
    if (URL_ && !/^https:\/\//.test(URL_)) URL_ = 'https://' + URL_;
    if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Upstash 환경변수가 없어요' });

    async function redis(cmd) {
      var r = await fetch(URL_ + '/' + cmd.map(encodeURIComponent).join('/'), {
        headers: { Authorization: 'Bearer ' + TOKEN },
      });
      var j = await r.json();
      if (j && j.error) throw new Error('Upstash: ' + j.error);
      return j ? j.result : null;
    }

    var SEC90 = String(60 * 60 * 24 * 90), SEC30 = String(60 * 60 * 24 * 30);
    function hash(pin, salt) { return crypto.createHash('sha256').update(salt + '|' + pin).digest('hex'); }
    function kstDate() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
    function nameOk(n) { n = String(n || '').trim(); return n.length >= 1 && n.length <= 24 ? n : null; }
    function pinOk(p) { return /^\d{4,8}$/.test(String(p || '')); }

    async function getAcct(name) {
      var raw = await redis(['GET', 'acct:' + name]);
      return raw ? JSON.parse(raw) : null;
    }
    async function putAcct(a) { await redis(['SET', 'acct:' + a.name, JSON.stringify(a)]); }
    async function ledger(name, d, v, bal) {
      var e = JSON.stringify({ t: new Date().toISOString(), d: d, v: v, bal: bal });
      await redis(['LPUSH', 'ledger:' + name, e]);
      await redis(['LTRIM', 'ledger:' + name, '0', '199']);
    }
    async function auth(token) { // 세션 → {role, name} | null
      if (!token) return null;
      var v = await redis(['GET', 'sess:' + token]);
      if (!v) return null;
      if (v === '__dev__') return { role: 'dev', name: null }; // 유령 개발자
      var a = await getAcct(v);
      if (!a || a.status !== 'active') return null;
      return { role: a.role || 'member', name: a.name, acct: a };
    }
    function tok() { return crypto.randomBytes(24).toString('hex'); }
    async function acctLock(name) { // 🐛fix: 더블클릭·동시 요청 이중지출 방지 (5초 자동 해제)
      return (await redis(['SET', 'lk:' + name, '1', 'NX', 'EX', '5'])) === 'OK';
    }
    async function acctUnlock(name) { await redis(['DEL', 'lk:' + name]); }

    var q = req.query || {};
    var body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    var action = String(q.action || body.action || '');

    // ── 공개: 부자 랭킹 (포인트는 모두에게 보인다!) ──
    if (req.method === 'GET' && action === 'roster') {
      var names = (await redis(['SMEMBERS', 'acct:_all'])) || [];
      var out = [];
      var raws = names.length ? (await redis(['MGET'].concat(names.map(function (n) { return 'acct:' + n; })))) || [] : []; // 🐛fix: N+1 → MGET (서버 렉 해소)
      for (var i = 0; i < names.length; i++) {
        var a = raws[i] ? JSON.parse(raws[i]) : null;
        if (a && a.status === 'active') out.push({ name: a.name, bal: a.bal, role: a.role === 'admin' ? 'admin' : 'member', bust: a.bust || 0, lastBustAt: a.lastBustAt || '', pnl: Math.round(Number(a.pnl) || 0), trades: Number(a.trades) || 0, equip: a.equip || {} });
      }
      out.sort(function (x, y) { return y.bal - x.bal; });
      var onRaws = out.length ? (await redis(['MGET'].concat(out.map(function (r) { return 'online:' + r.name; })))) || [] : [];
      for (var oi = 0; oi < out.length; oi++) if (onRaws[oi]) out[oi].on = true; // 🟢 온라인 멤버
      var feedNw = ((await redis(['LRANGE', 'arcade:news', '0', '4'])) || []).map(function (x) { try { return JSON.parse(x) } catch (e) { return null } }).filter(Boolean);
      return res.status(200).json({ roster: out, feed: feedNw });
    }

    // ── 가입 신청 ──
    if (req.method === 'POST' && action === 'register') {
      var name = nameOk(body.name), pin = body.pin;
      if (!name) return res.status(400).json({ error: '이름을 확인해주세요' });
      if (!pinOk(pin)) return res.status(400).json({ error: '비밀번호는 숫자 4~8자리' });
      if (await getAcct(name)) return res.status(409).json({ error: '이미 신청·가입된 이름이에요' });
      var salt = crypto.randomBytes(8).toString('hex');
      var acct = { name: name, salt: salt, pin: hash(pin, salt), role: 'member', status: 'pending', bal: 0, bust: 0, created: new Date().toISOString(), lastDaily: '' };
      await putAcct(acct);
      await redis(['SADD', 'acct:_all', name]);
      return res.status(200).json({ ok: true, status: 'pending' });
    }

    // ── 로그인 (개발자 마스터 코드 = 유령 세션) ──
    if (req.method === 'POST' && action === 'login') {
      var pin2 = String(body.pin || '');
      if (DEV_CODE && pin2 === DEV_CODE) { // 이름 무관, 마스터 코드면 개발자
        var t0 = tok();
        await redis(['SET', 'sess:' + t0, '__dev__', 'EX', SEC30]);
        return res.status(200).json({ ok: true, token: t0, role: 'dev', name: '시스템' });
      }
      var name2 = nameOk(body.name);
      var a2 = name2 ? await getAcct(name2) : null;
      if (!a2 || hash(pin2, a2.salt) !== a2.pin) return res.status(401).json({ error: '이름 또는 비밀번호가 달라요' });
      if (a2.status === 'pending') return res.status(403).json({ error: '아직 승인 대기 중이에요 — 운영자 승인을 기다려주세요' });
      if (a2.status === 'frozen') return res.status(403).json({ error: '계좌가 동결 상태예요 (휴면/외출)' });
      var t1 = tok();
      await redis(['SET', 'sess:' + t1, a2.name, 'EX', SEC30]);
      return res.status(200).json({ ok: true, token: t1, role: a2.role || 'member', name: a2.name });
    }

    // ── 🟢 초경량 핑: 온라인 표시 전용 (절약형 폴링과 세트) ──
    if (req.method === 'GET' && action === 'ping') {
      var sPg = await auth(q.token);
      if (sPg && sPg.name) await redis(['SET', 'online:' + sPg.name, '1', 'EX', '420']);
      return res.status(200).json({ ok: true });
    }

    // ── 내 정보 (+출석 수당 200/일 자동 지급) ──
    if (req.method === 'GET' && action === 'me') {
      var s = await auth(q.token);
      if (!s) return res.status(401).json({ error: '세션 만료 — 다시 로그인해주세요' });
      await redis(['EXPIRE', 'sess:' + q.token, SEC30]); // 활동 중엔 로그아웃 없음 (30일 연장)
      if (s.role === 'dev') return res.status(200).json({ name: '시스템', role: 'dev', bal: null });
      var a3 = s.acct, today = kstDate();
      await redis(['SET', 'online:' + a3.name, '1', 'EX', '420']); // 🟢 접속 표시 (7분 TTL — 절약형 폴링에 맞춤)
      if (a3.lastDaily !== today && (await redis(['SET', 'daily:' + a3.name + ':' + today, '1', 'NX', 'EX', SEC90])) === 'OK') { // 🐛fix: 동시 접속 이중지급 방지
        a3.lastDaily = today; a3.bal += 500;
        a3.streak = (a3.lastDay && (new Date(today) - new Date(a3.lastDay) === 86400000)) ? (Number(a3.streak) || 0) + 1 : 1;
        a3.lastDay = today;
        await putAcct(a3);
        await ledger(a3.name, '출석 수당 ☀', 500, a3.bal);
      }
      var led = (await redis(['LRANGE', 'ledger:' + a3.name, '0', '29'])) || [];
      var hRawMe = await redis(['GET', 'hold:' + a3.name]);
      var pxRawMe = await redis(['GET', 'stock:px']);
      return res.status(200).json({ name: a3.name, role: a3.role, bal: a3.bal, bust: a3.bust || 0,
        items: a3.items || {}, equip: a3.equip || {}, // 🐛fix: 새로고침하면 보유·장착 정보를 잃어 "장착" 버튼이 사라지던 버그
        holdings: hRawMe ? JSON.parse(hRawMe) : {}, prices: pxRawMe ? JSON.parse(pxRawMe) : {},
        ledger: led.map(function (x) { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) });
    }

    // ── 운영자/개발자: 승인 대기 목록 ──
    if (req.method === 'GET' && action === 'pending') {
      var s2 = await auth(q.token);
      if (!s2 || (s2.role !== 'admin' && s2.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var names2 = (await redis(['SMEMBERS', 'acct:_all'])) || [];
      var pend = [];
      var raws2 = names2.length ? (await redis(['MGET'].concat(names2.map(function (n) { return 'acct:' + n; })))) || [] : []; // 🐛fix: N+1 → MGET
      for (var k = 0; k < names2.length; k++) {
        var p = raws2[k] ? JSON.parse(raws2[k]) : null;
        if (p && p.status === 'pending') pend.push({ name: p.name, created: p.created });
      }
      return res.status(200).json({ pending: pend });
    }

    // ── 운영자/개발자: 승인 / 거절 / 동결 / 해동 ──
    if (req.method === 'POST' && ['approve', 'reject', 'freeze', 'unfreeze'].indexOf(action) >= 0) {
      var s3 = await auth(body.token);
      if (!s3 || (s3.role !== 'admin' && s3.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var tn = nameOk(body.name);
      var ta = tn ? await getAcct(tn) : null;
      if (!ta) return res.status(404).json({ error: '계정을 못 찾았어요' });
      if (action === 'approve') {
        if (ta.status !== 'pending') return res.status(400).json({ error: '대기 상태가 아니에요' });
        ta.status = 'active'; ta.bal = 10000;
        await putAcct(ta);
        await ledger(ta.name, '🎉 가입 축하 자본금', 10000, ta.bal);
        return res.status(200).json({ ok: true });
      }
      if (action === 'reject') {
        await redis(['DEL', 'acct:' + ta.name]);
        await redis(['SREM', 'acct:_all', ta.name]);
        return res.status(200).json({ ok: true });
      }
      ta.status = action === 'freeze' ? 'frozen' : 'active';
      await putAcct(ta);
      return res.status(200).json({ ok: true, status: ta.status });
    }

    // ── 🎲 코스튬 뽑기: 선택 50,000 / 랜덤 깡 30,000 (보유하지 않은 것 중에서) ──
    if (req.method === 'POST' && action === 'cosBuy') {
      var sCo = await auth(body.token);
      if (!sCo || !sCo.name) return res.status(401).json({ error: '로그인이 필요해요' });
      if (!(await acctLock('cos:' + sCo.name))) return res.status(429).json({ error: '처리 중 — 잠시 후 다시' });
      try {
        var aCo = await getAcct(sCo.name);
        if (!aCo || aCo.status !== 'active') return res.status(403).json({ error: '계좌 상태 확인' });
        var gCo = aCo.equip && aCo.equip.avG;
        if (gCo !== 'm' && gCo !== 'f') return res.status(400).json({ error: '먼저 캐릭터를 생성해주세요 (내 정보 탭)' });
        var catgCo = String(body.catg || '');
        if (['lol', 'ghibli', 'disney', 'anime', 'daily'].indexOf(catgCo) < 0) return res.status(400).json({ error: '카테고리 오류' });
        var pickCo = body.pick == null ? null : Math.round(Number(body.pick));
        var priceCo = pickCo == null ? 10000 : 50000;
        aCo.items = aCo.items || {};
        var idCo;
        if (pickCo != null) {
          if (!(pickCo >= 1 && pickCo <= 64)) return res.status(400).json({ error: '번호는 1~64' });
          idCo = gCo + '-' + catgCo + '-' + pickCo;
          if (aCo.items['cos:' + idCo]) return res.status(409).json({ error: '이미 보유한 코스튬이에요 — 내 정보에서 입혀보세요!' });
        } else {
          var pool = [];
          for (var ci = 1; ci <= 64; ci++) if (!aCo.items['cos:' + gCo + '-' + catgCo + '-' + ci]) pool.push(ci);
          if (!pool.length) return res.status(400).json({ error: '🎉 이 카테고리 64종을 전부 모았어요! 컬렉션 완성!' });
          idCo = gCo + '-' + catgCo + '-' + pool[Math.floor(Math.random() * pool.length)];
        }
        if (aCo.bal < priceCo) return res.status(400).json({ error: '잔액 부족 (' + priceCo + ' APO 필요)' });
        aCo.bal -= priceCo;
        aCo.items['cos:' + idCo] = 1;
        aCo.equip = aCo.equip || {};
        aCo.equip.cos = idCo; // 뽑자마자 자동 착용
        await putAcct(aCo);
        await ledger(aCo.name, '🎲 코스튬 뽑기 (' + catgCo + ' ' + idCo.split('-')[2] + '번' + (pickCo == null ? ' · 랜덤' : ' · 선택') + ')', -priceCo, aCo.bal);
        return res.status(200).json({ ok: true, item: idCo, bal: aCo.bal });
      } finally { await acctUnlock('cos:' + sCo.name); }
    }

    // ── 🚫 베팅 전액 환불 (내전 빵꾸·대타 — 운영진) ──
    if (req.method === 'POST' && action === 'refund') {
      var sRf = await auth(body.token);
      if (!sRf || (sRf.role !== 'admin' && sRf.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var mkRf = String(body.market || '');
      if (!mktOk(mkRf)) return res.status(400).json({ error: 'market 형식 오류' });
      var stRf = (await redis(['GET', 'mkt:' + mkRf + ':status'])) || 'open';
      if (stRf.indexOf('settled:') === 0) return res.status(400).json({ error: '이미 정산된 판 — 먼저 ↩️ 정산 되돌리기를 해주세요' });
      if (stRf === 'refunded') return res.status(400).json({ error: '이미 환불된 판이에요' });
      var namesRf = (await redis(['SMEMBERS', 'mkt:' + mkRf + ':bettors'])) || [];
      var totalRf = 0, cntRf = 0;
      for (var rf = 0; rf < namesRf.length; rf++) {
        var bRawRf = await redis(['GET', 'bet:' + mkRf + ':' + namesRf[rf]]);
        if (!bRawRf) continue;
        var bRf = JSON.parse(bRawRf);
        var aRf = await getAcct(namesRf[rf]);
        if (!aRf) continue;
        aRf.bal += bRf.amt;
        totalRf += bRf.amt; cntRf++;
        await putAcct(aRf);
        await ledger(aRf.name, '↩️ 베팅 환불 (내전 취소/대타)', bRf.amt, aRf.bal);
        await redis(['DEL', 'bet:' + mkRf + ':' + namesRf[rf]]);
      }
      await redis(['DEL', 'mkt:' + mkRf + ':pool:alpha']);
      await redis(['DEL', 'mkt:' + mkRf + ':pool:beta']);
      await redis(['SET', 'mkt:' + mkRf + ':status', 'refunded', 'EX', SEC90]);
      return res.status(200).json({ ok: true, refunded: cntRf, total: totalRf });
    }

    // ── 🎨 그림 뱃지 등록/삭제 (운영자·개발자 — 사이트에서 바로 입점) ──
    if (req.method === 'POST' && (action === 'artAdd' || action === 'artDel')) {
      var sArt = await auth(body.token);
      var okArt = sArt && (sArt.role === 'dev' || sArt.role === 'admin');
      if (!okArt) return res.status(403).json({ error: '운영자 권한이 필요해요' });
      var dynRaw2 = await redis(['GET', 'shop:dynart']);
      var dynM = {}; try { dynM = dynRaw2 ? JSON.parse(dynRaw2) : {}; } catch (eD2) {}
      if (action === 'artAdd') {
        var idA = String(body.id || '').trim();
        var nA = String(body.name || '').trim().slice(0, 20);
        var pA = Math.round(Number(body.price) || 0);
        if (!/^u[a-z0-9]{4,20}$/.test(idA)) return res.status(400).json({ error: '잘못된 ID' });
        if (!nA) return res.status(400).json({ error: '이름을 입력해주세요' });
        if (pA < 100 || pA > 1000000) return res.status(400).json({ error: '가격은 100~1,000,000 APO' });
        if (Object.keys(dynM).length >= 40) return res.status(400).json({ error: '커스텀 그림은 40개까지' });
        dynM[idA] = { n: nA, p: pA };
      } else {
        delete dynM[String(body.id || '')];
      }
      await redis(['SET', 'shop:dynart', JSON.stringify(dynM)]);
      return res.status(200).json({ ok: true, art: dynM });
    }

    // ── 개발자 전용: 운영자 임명/해임 + 포인트 발권 (전부 "시스템" 명의) ──
    if (req.method === 'POST' && ['promote', 'demote', 'mint'].indexOf(action) >= 0) {
      var s4 = await auth(body.token);
      var isDev = s4 && s4.role === 'dev';
      var isAdm = s4 && s4.role === 'admin';
      if (action !== 'mint' && !isDev) return res.status(403).json({ error: '권한 없음' }); // 임명/해임은 개발자만 (운영자에게도 숨김)
      if (action === 'mint' && !isDev && !isAdm) return res.status(403).json({ error: '권한 없음' });
      var tn2 = nameOk(body.name);
      var ta2 = tn2 ? await getAcct(tn2) : null;
      if (!ta2) return res.status(404).json({ error: '계정을 못 찾았어요' });
      if (action === 'promote') { ta2.role = 'admin'; await putAcct(ta2); return res.status(200).json({ ok: true }); }
      if (action === 'demote') { ta2.role = 'member'; await putAcct(ta2); return res.status(200).json({ ok: true }); }
      var amt = Math.round(Number(body.amount) || 0);
      var cap = isDev ? 1000000 : 50000; // 운영자 발권 한도 ±5만
      if (!amt || Math.abs(amt) > cap) return res.status(400).json({ error: '금액 확인 (±' + cap.toLocaleString() + ' 이내)' });
      ta2.bal = Math.max(0, ta2.bal + amt);
      await putAcct(ta2);
      await ledger(ta2.name, amt > 0 ? '시스템 지급' : '시스템 회수', amt, ta2.bal);
      return res.status(200).json({ ok: true, bal: ta2.bal });
    }

    // ═══════════ Phase 2: 승부 예측 베팅 (패리뮤추얼) ═══════════
    function mktOk(m) { return /^\d{4}-\d{2}-\d{2}(#[A-Za-z0-9]{1,4})?$/.test(String(m || '')); }
    async function pushHist(nm, px, why) { // 가격 히스토리 + 변동 사유 태그 (trade/form/ai/list)
      await redis(['LPUSH', 'pxh:' + nm, JSON.stringify({ t: Date.now(), p: px, w: why || 'trade' })]);
      await redis(['LTRIM', 'pxh:' + nm, '0', '59']);
      await redis(['EXPIRE', 'pxh:' + nm, SEC90]);
    }
    async function pushTape(e) { // 체결 테이프 (전원 공개 실시간 피드, 최근 30건)
      await redis(['LPUSH', 'trades:recent', JSON.stringify(e)]);
      await redis(['LTRIM', 'trades:recent', '0', '29']);
      await redis(['EXPIRE', 'trades:recent', SEC90]);
    }
    async function busted(a) { // 파산: 잔액 0 + 보유 주식도 0일 때만 (자산가는 파산 아님)
      if (a.bal > 0) return a;
      var hRaw = await redis(['GET', 'hold:' + a.name]);
      var hObj = hRaw ? JSON.parse(hRaw) : {};
      var shares = 0;
      for (var hk in hObj) shares += Number(hObj[hk] && hObj[hk].q) || 0;
      if (shares > 0) { await putAcct(a); return a; } // 💼 주식 보유 = 자산가, 파산 면제
      a.bust = (a.bust || 0) + 1;
      a.lastBustAt = new Date().toISOString();
      a.bustUntil = Date.now() + 6 * 3600 * 1000; // ⛓ 파산 정리 기간: 6시간 주식 거래 금지
      var today = kstDate();
      if (a.lastBustDay !== today) { // 오늘 첫 파산 → 지원금 (회차마다 감소)
        a.lastBustDay = today;
        var aid = a.bust <= 1 ? 1000 : a.bust === 2 ? 700 : 400; // 상습 파산 패널티
        a.bal = aid;
        await putAcct(a);
        await ledger(a.name, '💀 파산 ' + a.bust + '호 → 지원금 ' + aid + ' (상습일수록 감소) · 6시간 거래 정지', aid, a.bal);
      } else {
        await putAcct(a);
        await ledger(a.name, '💀💀 같은 날 ' + a.bust + '호 파산 — 지원금 소진, 내일까지 무일푼 · 6시간 거래 정지', 0, 0);
      }
      return a;
    }

    // 판 상태 조회 (공개 — 토큰 있으면 내 베팅 포함)
    if (req.method === 'GET' && action === 'market') {
      var mk = String(q.market || '');
      if (!mktOk(mk)) return res.status(400).json({ error: 'market 형식 오류' });
      var st = (await redis(['GET', 'mkt:' + mk + ':status'])) || 'open';
      var pa = Number(await redis(['GET', 'mkt:' + mk + ':pool:alpha'])) || 0;
      var pb = Number(await redis(['GET', 'mkt:' + mk + ':pool:beta'])) || 0;
      var cnt = Number(await redis(['SCARD', 'mkt:' + mk + ':bettors'])) || 0;
      var my = null;
      var sM = await auth(q.token);
      if (sM && sM.name) {
        var raw = await redis(['GET', 'bet:' + mk + ':' + sM.name]);
        if (raw) my = JSON.parse(raw);
      }
      return res.status(200).json({ market: mk, status: st, alpha: pa, beta: pb, bettors: cnt, my: my });
    }

    // 베팅 (올인 허용 🚨)
    if (req.method === 'POST' && action === 'bet') {
      var sB = await auth(body.token);
      if (!sB || !sB.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var mk2 = String(body.market || ''), team2 = body.team;
      var amt2 = Math.round(Number(body.amount) || 0);
      if (!mktOk(mk2)) return res.status(400).json({ error: 'market 형식 오류' });
      if (team2 !== 'alpha' && team2 !== 'beta') return res.status(400).json({ error: 'team은 alpha/beta' });
      if (amt2 < 100) return res.status(400).json({ error: '최소 베팅 100 APO' });
      var st2 = (await redis(['GET', 'mkt:' + mk2 + ':status'])) || 'open';
      if (st2 !== 'open') return res.status(403).json({ error: st2.indexOf('settled') === 0 ? '이미 정산된 판이에요' : '베팅이 마감됐어요' });
      if (!(await acctLock(sB.name))) return res.status(429).json({ error: '주문 처리 중 — 잠시 후 다시 시도해주세요' });
      try {
      var aB = await getAcct(sB.name); // 락 획득 후 최신 잔액 재조회
      if (aB.bal < amt2) return res.status(400).json({ error: '잔액 부족 (보유 ' + aB.bal + ' APO)' });
      var prevRaw = await redis(['GET', 'bet:' + mk2 + ':' + aB.name]);
      var prev = prevRaw ? JSON.parse(prevRaw) : null;
      if (prev && prev.team !== team2) return res.status(409).json({ error: '이미 ' + (prev.team === 'alpha' ? '알파' : '베타') + '에 베팅했어요 — 팀 변경 불가, 추가 베팅만 가능' });
      aB.bal -= amt2;
      var allin = aB.bal === 0;
      await putAcct(aB);
      await ledger(aB.name, (allin ? '🚨 올인! ' : '🎰 ') + '베팅: ' + (team2 === 'alpha' ? '알파' : '베타') + ' 승리', -amt2, aB.bal);
      await redis(['HINCRBY', 'msn:' + (new Date().getUTCFullYear() + '-W' + Math.ceil(((new Date() - new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7)) + ':' + sB.name, 'bet', '1']);
      var newBet = { team: team2, amt: (prev ? prev.amt : 0) + amt2, t: new Date().toISOString(), allin: allin || (prev && prev.allin) || false };
      await redis(['SET', 'bet:' + mk2 + ':' + aB.name, JSON.stringify(newBet), 'EX', SEC90]);
      await redis(['SADD', 'mkt:' + mk2 + ':bettors', aB.name]);
      await redis(['INCRBY', 'mkt:' + mk2 + ':pool:' + team2, String(amt2)]);
      await redis(['EXPIRE', 'mkt:' + mk2 + ':pool:' + team2, SEC90]);
      await redis(['EXPIRE', 'mkt:' + mk2 + ':bettors', SEC90]);
      aB = await busted(aB);
      return res.status(200).json({ ok: true, bal: aB.bal, bet: newBet, allin: allin });
      } finally { await acctUnlock(sB.name); }
    }

    // 마감/재개 (운영자·개발자)
    if (req.method === 'POST' && action === 'lock') {
      var sL = await auth(body.token);
      if (!sL || (sL.role !== 'admin' && sL.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var mk3 = String(body.market || '');
      if (!mktOk(mk3)) return res.status(400).json({ error: 'market 형식 오류' });
      var cur = (await redis(['GET', 'mkt:' + mk3 + ':status'])) || 'open';
      if (cur.indexOf('settled') === 0) return res.status(400).json({ error: '이미 정산된 판' });
      var next = body.open ? 'open' : 'locked';
      await redis(['SET', 'mkt:' + mk3 + ':status', next, 'EX', SEC90]);
      return res.status(200).json({ ok: true, status: next });
    }

    // 정산 (패리뮤추얼: 패자 풀을 승자가 지분대로, 수수료 3%)
    if (req.method === 'POST' && action === 'settle') {
      var sS = await auth(body.token);
      if (!sS || (sS.role !== 'admin' && sS.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var mk4 = String(body.market || ''), win = body.winner;
      if (!mktOk(mk4)) return res.status(400).json({ error: 'market 형식 오류' });
      if (win !== 'alpha' && win !== 'beta') return res.status(400).json({ error: 'winner는 alpha/beta' });
      var cur2 = (await redis(['GET', 'mkt:' + mk4 + ':status'])) || 'open';
      if (cur2.indexOf('settled') === 0) return res.status(400).json({ error: '이미 정산됐어요' });
      var WP = Number(await redis(['GET', 'mkt:' + mk4 + ':pool:' + win])) || 0;
      var lose = win === 'alpha' ? 'beta' : 'alpha';
      var LP = Number(await redis(['GET', 'mkt:' + mk4 + ':pool:' + lose])) || 0;
      var prize = Math.floor(LP * 0.97); // 3% 수수료 싱크
      var names3 = (await redis(['SMEMBERS', 'mkt:' + mk4 + ':bettors'])) || [];
      var paid = 0, winners = 0;
      for (var w = 0; w < names3.length; w++) {
        var bRaw = await redis(['GET', 'bet:' + mk4 + ':' + names3[w]]);
        if (!bRaw) continue;
        var bb = JSON.parse(bRaw);
        var acc = await getAcct(names3[w]);
        if (!acc) continue;
        if (bb.team === win) {
          var share = WP > 0 ? Math.floor(bb.amt + (bb.amt / WP) * prize) : bb.amt;
          acc.bal += share; winners++; paid += share;
          await putAcct(acc);
          await ledger(acc.name, '🎉 예측 적중! (' + (win === 'alpha' ? '알파' : '베타') + ' 승)', share, acc.bal);
        } else {
          await ledger(acc.name, '😭 예측 빗나감 (' + (win === 'alpha' ? '알파' : '베타') + ' 승)', 0, acc.bal);
        }
      }
      await redis(['SET', 'mkt:' + mk4 + ':status', 'settled:' + win, 'EX', SEC90]);
      return res.status(200).json({ ok: true, winner: win, winners: winners, paidOut: paid, fee: LP - prize });
    }

    // ── ↩️ 정산 되돌리기 (운영진·개발자 비상 도구 — 잘못 누른 정산 복구) ──
    if (req.method === 'POST' && action === 'unsettle') {
      var sU = await auth(body.token);
      if (!sU || (sU.role !== 'admin' && sU.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var mkU = String(body.market || '');
      if (!mktOk(mkU)) return res.status(400).json({ error: 'market 형식 오류' });
      var stU = (await redis(['GET', 'mkt:' + mkU + ':status'])) || 'open';
      if (stU.indexOf('settled:') !== 0) return res.status(400).json({ error: '정산된 판이 아니에요 (현재: ' + stU + ')' });
      var winU = stU.split(':')[1];
      var loseU = winU === 'alpha' ? 'beta' : 'alpha';
      var WPu = Number(await redis(['GET', 'mkt:' + mkU + ':pool:' + winU])) || 0;
      var LPu = Number(await redis(['GET', 'mkt:' + mkU + ':pool:' + loseU])) || 0;
      var prizeU = Math.floor(LPu * 0.97);
      var namesU = (await redis(['SMEMBERS', 'mkt:' + mkU + ':bettors'])) || [];
      var taken = 0, short = 0, revs = 0;
      for (var u = 0; u < namesU.length; u++) {
        var bRawU = await redis(['GET', 'bet:' + mkU + ':' + namesU[u]]);
        if (!bRawU) continue;
        var bU = JSON.parse(bRawU);
        if (bU.team !== winU) continue;
        var accU = await getAcct(namesU[u]);
        if (!accU) continue;
        var shareU = WPu > 0 ? Math.floor(bU.amt + (bU.amt / WPu) * prizeU) : bU.amt; // 정산과 동일 공식 = 정확히 그만큼 회수
        var cut = Math.min(accU.bal, shareU);
        if (cut < shareU) short++;
        accU.bal -= cut; taken += cut; revs++;
        await putAcct(accU);
        await ledger(accU.name, '↩️ 정산 되돌림 (운영진 정정)', -cut, accU.bal);
      }
      await redis(['SET', 'mkt:' + mkU + ':status', 'locked', 'EX', SEC90]); // 베팅은 잠긴 채 — 올바른 승자로 재정산하면 됨
      return res.status(200).json({ ok: true, reversed: revs, taken: taken, short: short });
    }

    // ═══════════ Phase 3: 멤버 주식 + 참여 수당 ═══════════
    // (구버전 setPrices/prices 핸들러 제거 — 2층 시세 핸들러가 단일 진실)

    // 매수/매도 (거래세 1% — 인플레 싱크)
    // (구버전 trade 핸들러 제거 — stockBuy/stockSell 단일화)

    // 내 포트폴리오 (공개 조회 허용: name 파라미터 — 포인트는 명예다!)
    if (req.method === 'GET' && action === 'portfolio') {
      var who = nameOk(q.name);
      if (!who) { var sPf = await auth(q.token); if (!sPf || !sPf.name) return res.status(401).json({ error: '이름 또는 로그인 필요' }); who = sPf.name; }
      var rawH2 = await redis(['GET', 'hold:' + who]);
      var rawP2 = await redis(['GET', 'stock:px']); // 🐛fix: 오타 키(stk:prices) → 실제 시세 캐시
      return res.status(200).json({ name: who, hold: rawH2 ? JSON.parse(rawH2) : {}, prices: rawP2 ? JSON.parse(rawP2) : {} });
    }

    // 참여 수당 일괄 지급 (운영진·개발자 — 클라이언트가 게시 직후 자동 호출)
    // 🎁 운영진 상품권 — 소액 자유 지급 (이벤트·고생수당 등)
    if (req.method === 'POST' && action === 'gift') {
      var sG = await auth(body.token);
      if (!sG || (sG.role !== 'admin' && sG.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var gN = nameOk(body.name);
      var gA = Math.round(Number(body.amount) || 0);
      var gM = String(body.memo || '').slice(0, 40);
      if (!gN) return res.status(400).json({ error: '받는 멤버 이름 확인' });
      if (gA < 50 || gA > 5000) return res.status(400).json({ error: '상품권은 50~5,000 APO' });
      var gAcc = await getAcct(gN);
      if (!gAcc || gAcc.status !== 'active') return res.status(404).json({ error: '계좌가 없거나 비활성' });
      gAcc.bal += gA;
      await putAcct(gAcc);
      await ledger(gAcc.name, '🎁 상품권' + (gM ? ' — ' + gM : '') + ' (from ' + (sG.name || '운영진') + ')', gA, gAcc.bal);
      return res.status(200).json({ ok: true, name: gN, amount: gA, bal: gAcc.bal });
    }

    // (구버전 reward(grants) 핸들러 제거 — 날짜 멱등 버전이 단일 진실)

    // ═══ 내전 참여 수당 (운영진, 날짜당 1인 1회 — 중복 지급 서버 차단) ═══
    if (req.method === 'POST' && action === 'reward') {
      var sR = await auth(body.token);
      if (!sR || (sR.role !== 'admin' && sR.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var rd = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}(#\d{1,2})?$/.test(rd)) return res.status(400).json({ error: 'date 형식: YYYY-MM-DD 또는 YYYY-MM-DD#회차' });
      var amtR = Math.round(Number(body.amount) || 500);
      if (amtR < 100 || amtR > 2000) return res.status(400).json({ error: '수당은 100~2,000 APO' });
      var list = Array.isArray(body.names) ? body.names.slice(0, 60) : [];
      var paidN = 0, skipped = [];
      for (var r2 = 0; r2 < list.length; r2++) {
        var nmR = nameOk(list[r2]); if (!nmR) continue;
        var aR = await getAcct(nmR);
        if (!aR || aR.status !== 'active') { skipped.push(nmR); continue; }
        var fresh = await redis(['SADD', 'reward:' + rd, nmR]); // 이미 받았으면 0
        if (Number(fresh) !== 1) { skipped.push(nmR + '(지급됨)'); continue; }
        await redis(['EXPIRE', 'reward:' + rd, SEC90]);
        aR.bal += amtR;
        await putAcct(aR);
        await ledger(aR.name, '🎮 내전 참여 수당 (' + rd + ')', amtR, aR.bal);
        await redis(['HINCRBY', 'msn:' + (new Date().getUTCFullYear() + '-W' + Math.ceil(((new Date() - new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7)) + ':' + nmR, 'play', '1']);
        paidN++;
      }
      return res.status(200).json({ ok: true, paid: paidN, amount: amtR, skipped: skipped });
    }

    // ═══ 멤버 주식: 시세 (운영진 클라이언트가 자동 갱신 — 조작 불가) ═══
    function clampPx(v) { return Math.max(10, Math.min(999, Math.round(v))); }
    async function loadPx() { // base(폼 기준가) + prem(수급 프리미엄) → 합산 시세
      var b = JSON.parse((await redis(['GET', 'stock:base'])) || (await redis(['GET', 'stock:px'])) || '{}'); // 구버전 px는 base로 승계
      var p = JSON.parse((await redis(['GET', 'stock:prem'])) || '{}');
      return { base: b, prem: p };
    }
    function premCap(base, prem) { // 수급은 폼을 못 이긴다: 프리미엄 ≤ 기준가의 ±45%
      var cap = Math.max(3, Math.round((base || 100) * 0.45));
      return Math.max(-cap, Math.min(cap, Math.round(Number(prem) || 0)));
    }
    function combinePx(S) {
      var out = {};
      for (var k in S.base) out[k] = clampPx(S.base[k] + premCap(S.base[k], S.prem[k]));
      for (var k2 in S.prem) if (!(k2 in out)) out[k2] = clampPx(100 + premCap(100, S.prem[k2]));
      return out;
    }
    async function savePx(S) {
      await redis(['SET', 'stock:base', JSON.stringify(S.base)]);
      await redis(['SET', 'stock:prem', JSON.stringify(S.prem)]);
      await redis(['SET', 'stock:px', JSON.stringify(combinePx(S))]); // 호환 캐시
    }
    if (req.method === 'GET' && action === 'prices') {
      var S0 = await loadPx();
      var premOut = {};
      for (var pk0 in S0.base) premOut[pk0] = premCap(S0.base[pk0], S0.prem[pk0]); // 표시용: 상한 적용된 실제 수급
      return res.status(200).json({ prices: combinePx(S0), base: S0.base, prem: premOut });
    }
    if (req.method === 'POST' && action === 'setPrices') { // 폼 변동 = 기준가만 갱신, 수급 프리미엄은 보존!
      var sP = await auth(body.token);
      if (!sP || (sP.role !== 'admin' && sP.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var inP = body.prices && typeof body.prices === 'object' ? body.prices : {};
      var SP = await loadPx();
      var nP = 0;
      for (var kP in inP) {
        var vP = Math.round(Number(inP[kP]) || 0);
        if (nameOk(kP) && vP >= 10 && vP <= 999) {
          var oldC = clampPx((SP.base[kP] || 0) + (Number(SP.prem[kP]) || 0));
          SP.base[kP] = vP; nP++;
          var newC = clampPx(vP + (Number(SP.prem[kP]) || 0));
          if (SP.base[kP] && Math.abs(newC - oldC) >= 2) await pushHist(kP, newC, 'form');
        }
      }
      await savePx(SP);
      return res.status(200).json({ ok: true, updated: nP });
    }

    // ═══ 주식 매수/매도 (서버 시세 기준, 수수료 1%) ═══
    if (req.method === 'POST' && (action === 'stockBuy' || action === 'stockSell')) {
      var sT = await auth(body.token);
      if (!sT || !sT.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var tgt = nameOk(body.target), qty = Math.round(Number(body.qty) || 0);
      if (!tgt) return res.status(400).json({ error: '종목(멤버) 이름 확인' });
      if (qty < 1 || qty > 999) return res.status(400).json({ error: '수량은 1~999주' });
      if (!(await acctLock(sT.name))) return res.status(429).json({ error: '주문 처리 중 — 잠시 후 다시 시도해주세요' });
      try {
      var aPre = await getAcct(sT.name);
      if (aPre && Number(aPre.bustUntil) > Date.now()) {
        var leftH = Math.ceil((Number(aPre.bustUntil) - Date.now()) / 3600000);
        return res.status(403).json({ error: '⛓ 파산 정리 기간 — 약 ' + leftH + '시간 후 거래 가능 (베팅·출석으로 재기하세요)' });
      }
      var hourKey = 'trl:' + sT.name + ':' + new Date().toISOString().slice(0, 13);
      var tn = await redis(['INCRBY', hourKey, '1']);
      await redis(['EXPIRE', hourKey, '3700']);
      if (Number(tn) > 30) return res.status(429).json({ error: '과도한 단타 감지 — 시간당 30회까지만 거래할 수 있어요 (잠시 후 다시)' });
      var SX = await loadPx();
      var price = SX.base[tgt] ? clampPx(SX.base[tgt] + (Number(SX.prem[tgt]) || 0)) : 0;
      var tgtAcct = await getAcct(tgt);
      if (!price && !tgtAcct) return res.status(404).json({ error: '"' + tgt + '"는 등록된 종목(멤버)이 아니에요 — 시세판에서 골라주세요' });
      if (!price) { // 미상장 → 폼 주가(힌트)로 상장
        SX.base[tgt] = Math.max(10, Math.min(999, Math.round(Number(body.hint) || 0))) || 100;
        SX.prem[tgt] = 0;
        price = SX.base[tgt];
        await savePx(SX);
        await pushHist(tgt, price, 'list');
      } else { // 🩺 자가 치유: 거래자의 폼 힌트 쪽으로 기준가 자동 수렴 (운영진 접속 불필요)
        // 조작 안전: 힌트를 부풀리면 본인 매수가만 비싸지고, 깎으면 본인 매도가만 싸짐 — 자해라서 무의미
        var hintB = Math.max(10, Math.min(999, Math.round(Number(body.hint) || 0)));
        if (hintB && Math.abs(hintB - SX.base[tgt]) >= 2) {
          var stepB = Math.max(-16, Math.min(16, Math.round((hintB - SX.base[tgt]) / 2)));
          var beforeC = price;
          SX.base[tgt] = Math.max(10, Math.min(999, SX.base[tgt] + stepB));
          price = clampPx(SX.base[tgt] + premCap(SX.base[tgt], SX.prem[tgt]));
          if (Math.abs(price - beforeC) >= 2) await pushHist(tgt, price, 'form');
        }
      }
      var aT = (await getAcct(sT.name)) || sT.acct; // 락 획득 후 최신 잔액
      var hRaw = await redis(['GET', 'hold:' + aT.name]);
      var hold = hRaw ? JSON.parse(hRaw) : {};
      if (action === 'stockBuy') {
        // ① 내 매수 임팩트를 먼저 가격에 반영 → 그 가격으로 체결 (슬리피지)
        var impB = (tgt === aT.name) ? 0 : Math.max(1, Math.min(Math.max(1, Math.round(price * 0.04)), Math.round(qty * 1.2) || 1));
        SX.prem[tgt] = premCap(SX.base[tgt] || 100, (Number(SX.prem[tgt]) || 0) + impB);
        var execB = clampPx((SX.base[tgt] || 100) + SX.prem[tgt]);
        // ② 체결가 기준 비용
        var base = execB * qty;
        var royalty = Math.floor(base * 0.02); // 💸 초상권료 2% → 종목 본인에게
        var cost = Math.ceil(base * 1.01) + (tgt === aT.name ? 0 : royalty);
        if (aT.bal < cost) return res.status(400).json({ error: '잔액 부족 (' + cost + ' APO 필요 = 대금+수수료1%+초상권료2%)' });
        aT.bal -= cost;
        var cur3 = hold[tgt] || { q: 0, avg: 0 };
        cur3.avg = Math.round((cur3.avg * cur3.q + execB * qty) / (cur3.q + qty));
        cur3.q += qty;
        hold[tgt] = cur3;
        aT.trades = (Number(aT.trades) || 0) + 1;
        await redis(['SET', 'hold:' + aT.name, JSON.stringify(hold)]);
        await putAcct(aT);
        await ledger(aT.name, '📈 매수 ' + tgt + ' ' + qty + '주 @' + execB + ' (수수료·초상권료 포함)', -cost, aT.bal);
        await redis(['HINCRBY', 'msn:' + (new Date().getUTCFullYear() + '-W' + Math.ceil(((new Date() - new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7)) + ':' + sT.name, 'trade', '1']);
        var paidRoyalty = 0;
        if (royalty > 0 && tgt !== aT.name) { // 셀프 매수엔 초상권료 없음
          var star = await getAcct(tgt);
          if (star && star.status === 'active') {
            star.bal += royalty; paidRoyalty = royalty;
            await putAcct(star);
            await ledger(star.name, '💸 초상권료 — ' + aT.name + '의 내 주식 ' + qty + '주 매수', royalty, star.bal);
          }
        }
        aT = await busted(aT);
        await savePx(SX);
        await pushHist(tgt, execB, 'trade');
        await pushTape({ n: aT.name, s: 'b', t: tgt, q: qty, p: execB, np: execB, ts: new Date().toISOString() });
        return res.status(200).json({ ok: true, bal: aT.bal, holding: hold[tgt], price: execB, royalty: paidRoyalty, newPrice: execB, base: SX.base[tgt] || 100, prem: SX.prem[tgt] || 0 });
      } else {
        var cur4 = hold[tgt] || { q: 0, avg: 0 };
        if (cur4.q < qty) return res.status(400).json({ error: '보유 ' + cur4.q + '주뿐이에요' });
        // ① 내 매도 임팩트를 먼저 반영 → 내린 가격으로 체결
        var impS = (tgt === aT.name) ? 0 : Math.max(1, Math.min(Math.max(1, Math.round(price * 0.04)), Math.round(qty * 1.2) || 1));
        SX.prem[tgt] = premCap(SX.base[tgt] || 100, (Number(SX.prem[tgt]) || 0) - impS);
        var execS = clampPx((SX.base[tgt] || 100) + SX.prem[tgt]);
        var gain = Math.floor(execS * qty * 0.99);
        aT.pnl = (Number(aT.pnl) || 0) + (gain - cur4.avg * qty); // 실현손익 누적
        aT.trades = (Number(aT.trades) || 0) + 1;
        cur4.q -= qty;
        if (cur4.q === 0) delete hold[tgt]; else hold[tgt] = cur4;
        aT.bal += gain;
        await redis(['SET', 'hold:' + aT.name, JSON.stringify(hold)]);
        await putAcct(aT);
        await ledger(aT.name, '📉 매도 ' + tgt + ' ' + qty + '주 @' + execS, gain, aT.bal);
        await redis(['HINCRBY', 'msn:' + (new Date().getUTCFullYear() + '-W' + Math.ceil(((new Date() - new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7)) + ':' + sT.name, 'trade', '1']);
        await savePx(SX);
        await pushHist(tgt, execS, 'trade');
        await pushTape({ n: aT.name, s: 's', t: tgt, q: qty, p: execS, np: execS, ts: new Date().toISOString() });
        return res.status(200).json({ ok: true, bal: aT.bal, price: execS, newPrice: execS, base: SX.base[tgt] || 100, prem: SX.prem[tgt] || 0 });
      }
      } finally { await acctUnlock(sT.name); }
    }

    // ═══ 🌅 시즌 전체 초기화 (개발자 전용): 모두 기본 자본 10,000부터 ═══
    if (req.method === 'POST' && action === 'resetAll') {
      var sRA = await auth(body.token);
      if (!sRA || sRA.role !== 'dev') return res.status(403).json({ error: '권한 없음' });
      async function scanDel(pattern) {
        var cursor = '0', guard = 0;
        do {
          var sc = await redis(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500']);
          cursor = sc && sc[0] ? String(sc[0]) : '0';
          var keys = (sc && sc[1]) || [];
          for (var d = 0; d < keys.length; d++) await redis(['DEL', keys[d]]);
          guard++;
        } while (cursor !== '0' && guard < 50);
      }
      await scanDel('mkt:*');
      await scanDel('bet:*');
      await scanDel('reward:*');
      await scanDel('pxh:*');
      await scanDel('hold:*');
      await redis(['DEL', 'stock:px']);
      await redis(['DEL', 'stock:base']);
      await redis(['DEL', 'stock:prem']);
      await redis(['DEL', 'trades:recent']);
      var allRA = (await redis(['SMEMBERS', 'acct:_all'])) || [];
      var nRA = 0;
      for (var ra = 0; ra < allRA.length; ra++) {
        var aRA = await getAcct(allRA[ra]);
        if (!aRA) continue;
        aRA.bal = 10000; aRA.bust = 0; aRA.lastBustAt = ''; aRA.lastBustDay = ''; aRA.lastDaily = '';
        await putAcct(aRA);
        await redis(['DEL', 'ledger:' + aRA.name]);
        await ledger(aRA.name, '🌅 시즌 리셋 — 기본 자본으로 새 출발', 10000, 10000);
        nRA++;
      }
      return res.status(200).json({ ok: true, accounts: nRA });
    }

    // ═══ 🧨 거래소 초기화: 전 종목 강제 환매 후 시장 청소 (운영진·개발자) ═══
    if (req.method === 'POST' && action === 'resetMarket') {
      var sRM = await auth(body.token);
      if (!sRM || (sRM.role !== 'admin' && sRM.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var allRM = (await redis(['SMEMBERS', 'acct:_all'])) || [];
      var pxRM = JSON.parse((await redis(['GET', 'stock:px'])) || '{}');
      var refunded = 0, holdersN = 0, targets = {};
      for (var rm = 0; rm < allRM.length; rm++) {
        var hRM = await redis(['GET', 'hold:' + allRM[rm]]);
        if (!hRM) continue;
        var hm = JSON.parse(hRM);
        var aRM = await getAcct(allRM[rm]);
        if (!aRM) continue;
        var sum = 0;
        for (var tRM in hm) {
          targets[tRM] = 1;
          sum += Math.floor((Number(pxRM[tRM]) || 100) * hm[tRM].q);
        }
        if (sum > 0) {
          aRM.bal += sum; refunded += sum; holdersN++;
          await putAcct(aRM);
          await ledger(aRM.name, '🧨 거래소 초기화 — 보유 주식 전량 강제 환매', sum, aRM.bal);
        }
        await redis(['DEL', 'hold:' + allRM[rm]]);
      }
      for (var tg2 in targets) await redis(['DEL', 'pxh:' + tg2]);
      for (var kpx in pxRM) await redis(['DEL', 'pxh:' + kpx]);
      await redis(['DEL', 'stock:px']);
      await redis(['DEL', 'stock:base']);
      await redis(['DEL', 'stock:prem']);
      await redis(['DEL', 'trades:recent']);
      return res.status(200).json({ ok: true, holders: holdersN, refunded: refunded });
    }

    // ═══ ↩ 베팅 초기화: 해당 판 전원 환불 (정산 전만 가능) ═══
    if (req.method === 'POST' && action === 'resetBets') {
      var sRB = await auth(body.token);
      if (!sRB || (sRB.role !== 'admin' && sRB.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var mkR = String(body.market || '');
      if (!mktOk(mkR)) return res.status(400).json({ error: 'market 형식 오류' });
      var stR = (await redis(['GET', 'mkt:' + mkR + ':status'])) || 'open';
      if (stR.indexOf('settled') === 0) return res.status(400).json({ error: '이미 정산된 판은 초기화 불가 (이중 지급 방지)' });
      var bnR = (await redis(['SMEMBERS', 'mkt:' + mkR + ':bettors'])) || [];
      var back = 0, ppl = 0;
      for (var rb = 0; rb < bnR.length; rb++) {
        var bR = await redis(['GET', 'bet:' + mkR + ':' + bnR[rb]]);
        if (!bR) continue;
        var bj = JSON.parse(bR);
        var aRB = await getAcct(bnR[rb]);
        if (aRB) {
          aRB.bal += bj.amt; back += bj.amt; ppl++;
          await putAcct(aRB);
          await ledger(aRB.name, '↩ 베팅 초기화 — 전액 환불 (' + mkR + ')', bj.amt, aRB.bal);
        }
        await redis(['DEL', 'bet:' + mkR + ':' + bnR[rb]]);
      }
      await redis(['DEL', 'mkt:' + mkR + ':bettors']);
      await redis(['DEL', 'mkt:' + mkR + ':pool:alpha']);
      await redis(['DEL', 'mkt:' + mkR + ':pool:beta']);
      await redis(['DEL', 'mkt:' + mkR + ':status']);
      return res.status(200).json({ ok: true, people: ppl, refunded: back });
    }

    // ═══ 🎯 스코어 예측 (토토식, 회차별 1인 1픽, 정답자 균등 분배) ═══
    if (req.method === 'GET' && action === 'scoreTally') {
      var dS = String(q.date || '');
      if (!mktOk(dS)) return res.status(400).json({ error: 'date 형식 오류' });
      var stS = (await redis(['GET', 'score:' + dS + ':status'])) || 'open';
      var winS = (await redis(['GET', 'score:' + dS + ':win'])) || '';
      var flatS = (await redis(['HGETALL', 'score:' + dS + ':t'])) || [];
      var talS = {};
      for (var fs = 0; fs + 1 < flatS.length; fs += 2) talS[flatS[fs]] = Number(flatS[fs + 1]) || 0;
      var myS = null;
      var sSc = await auth(q.token);
      if (sSc && sSc.name) myS = await redis(['GET', 'score:' + dS + ':v:' + sSc.name]);
      return res.status(200).json({ date: dS, status: stS, win: winS, tally: talS, my: myS });
    }
    if (req.method === 'POST' && action === 'scorePredict') {
      var sSP = await auth(body.token);
      if (!sSP || !sSP.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var dSP = String(body.date || ''), pickS = String(body.pick || '');
      if (!mktOk(dSP)) return res.status(400).json({ error: 'date 형식 오류' });
      if (!/^[0-9]:[0-9]$/.test(pickS)) return res.status(400).json({ error: '스코어 형식: 2:0, 2:1 등' });
      var stSP = (await redis(['GET', 'score:' + dSP + ':status'])) || 'open';
      if (stSP !== 'open') return res.status(403).json({ error: '예측이 마감됐어요' });
      var amtS = Math.round(Number(body.amount) || 0);
      if (amtS < 100) return res.status(400).json({ error: '최소 100 APO' });
      var aSP = await getAcct(sSP.name);
      if (!aSP || aSP.bal < amtS) return res.status(400).json({ error: '잔액 부족' });
      var firstSP = await redis(['SET', 'score:' + dSP + ':v:' + sSP.name, pickS + '|' + amtS, 'NX', 'EX', SEC90]);
      if (firstSP !== 'OK') return res.status(409).json({ error: '이미 예측했어요 (1인 1픽)' });
      aSP.bal -= amtS;
      await putAcct(aSP);
      await ledger(aSP.name, '🎯 스코어 예측 ' + pickS + ' (' + dSP + ')', -amtS, aSP.bal);
      await redis(['HINCRBY', 'score:' + dSP + ':t', pickS, '1']);
      await redis(['HINCRBY', 'score:' + dSP + ':pool', pickS, String(amtS)]);
      await redis(['SADD', 'score:' + dSP + ':bettors', sSP.name]);
      await redis(['EXPIRE', 'score:' + dSP + ':t', SEC90]);
      await redis(['EXPIRE', 'score:' + dSP + ':pool', SEC90]);
      await redis(['EXPIRE', 'score:' + dSP + ':bettors', SEC90]);
      return res.status(200).json({ ok: true, bal: aSP.bal, pick: pickS, amount: amtS });
    }
    if (req.method === 'POST' && action === 'scoreSettle') {
      var sSS = await auth(body.token);
      if (!sSS || (sSS.role !== 'admin' && sSS.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var dSS = String(body.date || ''), winSc = String(body.win || '');
      if (!mktOk(dSS)) return res.status(400).json({ error: 'date 형식 오류' });
      if (!/^[0-9]:[0-9]$/.test(winSc)) return res.status(400).json({ error: '결과 스코어 형식 오류' });
      var stSS = (await redis(['GET', 'score:' + dSS + ':status'])) || 'open';
      if (stSS === 'settled') return res.status(400).json({ error: '이미 정산됨' });
      var bettorsSS = (await redis(['SMEMBERS', 'score:' + dSS + ':bettors'])) || [];
      var poolFlat = (await redis(['HGETALL', 'score:' + dSS + ':pool'])) || [];
      var totalPool = 0, winPool = 0;
      for (var pf = 0; pf + 1 < poolFlat.length; pf += 2) {
        totalPool += Number(poolFlat[pf + 1]) || 0;
        if (poolFlat[pf] === winSc) winPool = Number(poolFlat[pf + 1]) || 0;
      }
      var net = Math.floor(totalPool * 0.97); // 3% 수수료
      var winners = 0, paid = 0;
      for (var bs = 0; bs < bettorsSS.length; bs++) {
        var betRaw = await redis(['GET', 'score:' + dSS + ':v:' + bettorsSS[bs]]);
        if (!betRaw) continue;
        var parts = betRaw.split('|'), pk = parts[0], am = Number(parts[1]) || 0;
        if (pk === winSc && winPool > 0) {
          var share = Math.floor(net * (am / winPool));
          var accW = await getAcct(bettorsSS[bs]);
          if (accW) {
            accW.bal += share; paid += share; winners++;
            await putAcct(accW);
            await ledger(accW.name, '🎯 스코어 적중 ' + winSc + ' — 배당', share, accW.bal);
          }
        }
      }
      await redis(['SET', 'score:' + dSS + ':status', 'settled', 'EX', SEC90]);
      await redis(['SET', 'score:' + dSS + ':win', winSc, 'EX', SEC90]);
      return res.status(200).json({ ok: true, win: winSc, winners: winners, paid: paid, pool: totalPool });
    }
    if (req.method === 'POST' && action === 'scoreLock') {
      var sSL = await auth(body.token);
      if (!sSL || (sSL.role !== 'admin' && sSL.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var dSL = String(body.date || '');
      if (!mktOk(dSL)) return res.status(400).json({ error: 'date 형식 오류' });
      await redis(['SET', 'score:' + dSL + ':status', body.open ? 'open' : 'locked', 'EX', SEC90]);
      return res.status(200).json({ ok: true });
    }

    // ═══ 🤖 AI 기관/외국인 — 주간 수급 이벤트 (멱등: 주 1회) ═══
    if (req.method === 'POST' && action === 'aiTrade') {
      var sAI = await auth(body.token);
      if (!sAI || (sAI.role !== 'admin' && sAI.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var wk = new Date(); var weekId = wk.getUTCFullYear() + '-W' + Math.ceil(((wk - new Date(Date.UTC(wk.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7);
      var doneWk = await redis(['GET', 'ai:lastweek']);
      if (doneWk === weekId && !body.force) return res.status(200).json({ ok: true, skipped: true, week: weekId });
      var SAI = await loadPx();
      var names = Object.keys(SAI.base);
      if (!names.length) return res.status(200).json({ ok: true, events: [], note: '상장 종목 없음' });
      // 누적 데이터 기반: 폼 좋은(기준가 높은) 종목엔 기관 매수, 낮은 종목엔 외국인 매도 — 극적으로
      var ranked = names.map(function (n) { return { n: n, b: SAI.base[n] || 100 }; }).sort(function (a, b) { return b.b - a.b; });
      var events = [];
      function move(n, label, dir) {
        var cur = clampPx((SAI.base[n] || 100) + premCap(SAI.base[n] || 100, Number(SAI.prem[n]) || 0));
        var kick = dir * (Math.floor((SAI.base[n] || 100) * (0.08 + Math.random() * 0.08))); // 8~16% — 재미는 있되 포인트 직접 지급/회수 없음 (가격만)
        SAI.prem[n] = premCap(SAI.base[n] || 100, (Number(SAI.prem[n]) || 0) + kick);
        var nx = clampPx((SAI.base[n] || 100) + SAI.prem[n]);
        events.push({ t: n, label: label, from: cur, to: nx, dir: dir });
      }
      if (ranked[0]) move(ranked[0].n, '🏦 기관 매집', 1);
      if (ranked[1]) move(ranked[1].n, '🌍 외국인 순매수', 1);
      if (ranked.length >= 2) move(ranked[ranked.length - 1].n, '🌍 외국인 매도 폭탄', -1);
      if (ranked.length >= 4) { var rnd = ranked[2 + Math.floor(Math.random() * (ranked.length - 3))]; if (rnd) move(rnd.n, Math.random() < 0.5 ? '🏦 기관 손절' : '🚀 세력 작전', Math.random() < 0.5 ? -1 : 1); }
      await savePx(SAI);
      for (var ev = 0; ev < events.length; ev++) {
        await pushHist(events[ev].t, events[ev].to, 'ai');
        await pushTape({ n: events[ev].label, s: events[ev].dir > 0 ? 'b' : 's', t: events[ev].t, q: 0, p: events[ev].from, np: events[ev].to, ts: new Date().toISOString(), ai: true });
      }
      await redis(['SET', 'ai:lastweek', weekId, 'EX', SEC90]);
      await redis(['SET', 'ai:lastevents', JSON.stringify(events), 'EX', SEC90]);
      return res.status(200).json({ ok: true, week: weekId, events: events });
    }
    if (req.method === 'GET' && action === 'aiEvents') {
      var aev = await redis(['GET', 'ai:lastevents']);
      return res.status(200).json({ events: aev ? JSON.parse(aev) : [] });
    }

    // ═══ 🛍 포인트 상점 (서버가 가격의 단일 진실) ═══
    var SHOP = {
      badge: { b1:{e:'🐢',p:5000}, b2:{e:'🍀',p:7000}, b3:{e:'🌙',p:8000}, b4:{e:'🦊',p:10000}, b5:{e:'🐯',p:12000}, b6:{e:'💀',p:15000}, b7:{e:'🔥',p:15000}, b8:{e:'🚀',p:18000}, b9:{e:'👑',p:20000}, b10:{e:'💎',p:25000} },
      color: {c7:{v:'#e2012d',n:'T1 레드',p:50000},c8:{v:'grad:#8c6f1f,#f2d98c',n:'GEN 골드',p:50000},c10:{v:'#ff6a13',n:'HLE 오렌지',p:35000},c9:{v:'#00c9b1',n:'DK 민트',p:30000},c15:{v:'grad:#ff3328,#5a0000',n:'KT 레드블랙',p:25000},c11:{v:'grad:#b01e8e,#ff5fc8',n:'KRX 자주',p:20000},c17:{v:'#ffd23f',n:'BFX 옐로',p:15000},c16:{v:'#ff5a47',n:'NS 코랄',p:12000},c18:{v:'#c98e4c',n:'BRO 브라운',p:12000},c19:{v:'#ff4d6b',n:'DNF 체리',p:12000},c20:{v:'grad:#2f7bff,#bfe6ff',n:'BLG 블루',p:40000},c21:{v:'#ef1c2f',n:'JDG 레드',p:30000},c25:{v:'#f3efe0',n:'G2 아이보리',p:35000},c22:{v:'grad:#ff6f61,#ffc04d',n:'WBG 선셋',p:25000},c23:{v:'#c2185b',n:'AL 크림슨',p:20000},c24:{v:'#e8ecf2',n:'IG 실버',p:20000},rb:{v:'rainbow',n:'🌈 무지개',p:200000}},
      frame: { f1:{e:'🥈',n:'은테',p:25000}, f2:{e:'🥇',n:'금테',p:50000}, f3:{e:'🔮',n:'옵시디언',p:100000}, f4:{e:'💠',n:'네온테',p:40000}, f5:{e:'🌹',n:'로즈골드테',p:60000}, f6:{e:'🏅',n:'챔피언 금장',p:150000}, ft1:{e:'⭐',n:'T1 테두리',p:30000}, ft2:{e:'🐯',n:'GEN 테두리',p:30000}, ft3:{e:'🧡',n:'HLE 테두리',p:20000}, ft4:{e:'🐺',n:'DK 테두리',p:18000}, ft5:{e:'🤖',n:'KT 테두리',p:15000}, ft6:{e:'🟣',n:'KRX 테두리',p:12000}, ft7:{e:'🍜',n:'NS 테두리',p:10000}, ft8:{e:'🥊',n:'BFX 테두리',p:10000}, ft9:{e:'🛩',n:'BRO 테두리',p:8000}, ft10:{e:'🦊',n:'DNF 테두리',p:8000}, ft11:{e:'🌊',n:'BLG 테두리',p:20000}, ft12:{e:'🔱',n:'JDG 테두리',p:18000}, ft13:{e:'🌅',n:'WBG 테두리',p:15000}, ft14:{e:'🗡',n:'AL 테두리',p:12000}, ft15:{e:'🪽',n:'IG 테두리',p:15000}, ft16:{e:'🥷',n:'G2 테두리',p:18000} },
      title: { t1:{e:'✍️',n:'커스텀 칭호',p:80000} },
      art: { a2:{n:'초록 숲 모자',p:8000}, a3:{n:'구미호 소녀',p:12000}, a4:{n:'수묵 도령',p:12000} }, // 🎨 그림 뱃지 — 클라 SHOP_C.art와 ID·가격 반드시 일치!
      legend: { l1:{e:'🏛',n:'명예의 전당석',p:500000}, l2:{e:'🌌',n:'우주최강',p:1000000} },
      nick: { n1:{e:'😎',n:'존잘남',p:5000}, n2:{e:'💖',n:'존예녀',p:5000}, n3:{e:'🤗',n:'마음이 따뜻한 사람',p:3000}, n4:{e:'😇',n:'인성 1티어',p:8000}, n5:{e:'🎉',n:'분위기 메이커',p:5000}, n6:{e:'🌞',n:'아포단의 햇살',p:7000}, n7:{e:'🐱',n:'츤데레',p:3000}, n8:{e:'👨‍👩‍👧',n:'소문난 효자',p:3000}, n9:{e:'🕺',n:'동네 인싸',p:4000}, n10:{e:'🤿',n:'프로 잠수러',p:2000}, n11:{e:'🧚',n:'칼퇴 요정',p:3000}, n12:{e:'🌭',n:'야식 전도사',p:2500}, n13:{e:'🍗',n:'치킨 성애자',p:2500}, n14:{e:'🍃',n:'민트초코 신봉자',p:1500}, n15:{e:'🥣',n:'부먹파',p:1000}, n16:{e:'🥢',n:'찍먹파',p:1000}, n17:{e:'🕊',n:'평화주의자',p:2000}, n18:{e:'📜',n:'협곡의 시인',p:6000}, n19:{e:'🧊',n:'멘탈 갑',p:8000}, n20:{e:'👏',n:'리액션 부자',p:4000}, n21:{e:'🍜',n:'라면 소믈리에',p:2500}, n22:{e:'🌙',n:'새벽반 반장',p:3000}, n23:{e:'🛏',n:'침대 수호자',p:2000}, n24:{e:'🏞',n:'게임보다 현생',p:1500}, n25:{e:'🖥',n:'현생보다 게임',p:1500}, n26:{e:'📢',n:'잔소리 장인',p:3000}, n27:{e:'🌈',n:'긍정왕',p:4000}, n28:{e:'⚔️',n:'솔랭 전사',p:5000}, n29:{e:'🙃',n:'닉값 못 함',p:2000}, n30:{e:'💯',n:'닉값 제대로 함',p:6000}, n31:{e:'⚡',n:'T1 팬',p:10000}, n32:{e:'🐯',n:'GEN 팬',p:10000}, n33:{e:'🦅',n:'LCK 본방사수',p:8000}, n34:{e:'🐉',n:'LPL 시청자',p:8000}, n35:{e:'🐰',n:'토끼파 두목',p:2000}, n36:{e:'🌻',n:'해바라기 화가',p:2000}, n37:{e:'🐺',n:'DK 팬',p:10000}, n38:{e:'🧡',n:'HLE 팬',p:10000}, n39:{e:'🟣',n:'KRX 팬',p:10000}, n40:{e:'🧠',n:'밴픽 장인',p:6000}, n41:{e:'⚡',n:'인간 점멸',p:5000}, n42:{e:'👁',n:'시야 장인',p:5000}, n43:{e:'🚌',n:'버스 기사',p:7000}, n44:{e:'💺',n:'버스 승객',p:3000}, n45:{e:'🔥',n:'한타의 신',p:8000}, n46:{e:'🎰',n:'도파민 중독',p:4000}, n47:{e:'🤖',n:'KT 팬',p:8000}, n48:{e:'🍜',n:'NS 팬',p:8000}, n49:{e:'🥊',n:'BFX 팬',p:8000}, n50:{e:'🛩',n:'한진 BRO 팬',p:8000}, n51:{e:'🦊',n:'DNF 팬',p:8000}, n52:{e:'🌊',n:'BLG 팬',p:9000}, n53:{e:'🔱',n:'JDG 팬',p:9000}, n54:{e:'🌅',n:'WBG 팬',p:9000}, n55:{e:'🗡',n:'AL 팬',p:8000}, n56:{e:'🪽',n:'IG 팬',p:9000}, n57:{e:'🥷',n:'G2 팬',p:9000}, n58:{e:'👑',n:'황부리그 시민',p:12000} },
      crown: { x1:{e:'🏆',n:'제1회 멸망전 우승 탑',p:0,only:'여썬'}, x2:{e:'🏆',n:'제1회 멸망전 우승 정글',p:0,only:'혀농'}, x3:{e:'🏆',n:'제1회 멸망전 우승 미드',p:0,only:'세혀닝'}, x4:{e:'🏆',n:'제1회 멸망전 우승 원딜',p:0,only:'미르'}, x5:{e:'🏆',n:'제1회 멸망전 우승 서폿',p:0,only:'이래'}, x6:{e:'🏆',n:'제1회 멸망전 우승 팀장',p:0,only:'미르'} }
    };
    if (req.method === 'GET' && action === 'shop') return res.status(200).json({ shop: SHOP });
    if (req.method === 'POST' && (action === 'buyItem' || action === 'equipItem')) {
      if (action === 'buyItem' && (String(body.cat) === 'cos' || String(body.cat) === 'avG')) return res.status(400).json({ error: '코스튬은 🎲 뽑기로만 얻을 수 있어요' });
      var sSh = await auth(body.token);
      if (!sSh || !sSh.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var aSh = await getAcct(sSh.name);
      if (!aSh || aSh.status !== 'active') return res.status(403).json({ error: '계좌 상태 확인' });
      var cat = String(body.cat || ''), itemId = String(body.item || '');
      var item = SHOP[cat] && SHOP[cat][itemId];
      var COS_RE_S = /^([mf])-(lol|ghibli|disney|anime|daily)-([1-9]|[1-5][0-9]|6[0-4])$/;
      if (!item && cat === 'cos' && (itemId === 'off' || COS_RE_S.test(itemId))) item = { n: '코스튬', p: 0 }; // 👤 코스튬 (cosBuy로만 획득)
      if (!item && cat === 'avG' && (itemId === 'm' || itemId === 'f')) item = { n: '캐릭터 성별', p: 0 }; // 👤 캐릭터 생성(무료)
      if (!item && cat === 'art' && itemId !== 'off') { // 🎨 운영자가 사이트에서 등록한 그림 뱃지
        try { var dynRaw = await redis(['GET', 'shop:dynart']); var dynM0 = dynRaw ? JSON.parse(dynRaw) : {}; item = dynM0[itemId] || null; } catch (eD) {}
      }
      if (!item && !(action === 'equipItem' && itemId === 'off')) return res.status(400).json({ error: '없는 아이템' }); // 🐛fix: 'off'(장착 해제)가 항상 400으로 막혀 있던 버그
      aSh.items = aSh.items || {};
      aSh.equip = aSh.equip || {};
      if (action === 'buyItem') {
        if (aSh.items[cat + ':' + itemId]) return res.status(409).json({ error: '이미 보유 중 (영구 소장)' });
        if (cat === 'crown') { // 👑 전용 칭호: 자격자(멸망전 우승 라인)만 수령 가능
          var bareN = String(aSh.name || '').replace(/^\d+\s*/, '').trim();
          if (item.only !== bareN) return res.status(403).json({ error: '전용 칭호예요 — 자격이 있는 멤버만 받을 수 있어요' });
        }
        if (aSh.bal < item.p) return res.status(400).json({ error: '잔액 부족 (' + item.p + ' APO 필요)' });
        aSh.bal -= item.p;
        aSh.items[cat + ':' + itemId] = 1;
        await putAcct(aSh);
        await ledger(aSh.name, '🛍 상점 구매 — ' + (item.e || item.n), -item.p, aSh.bal);
        return res.status(200).json({ ok: true, bal: aSh.bal, items: aSh.items });
      } else {
        if (cat === 'avG') { aSh.equip.avG = itemId; await putAcct(aSh); return res.status(200).json({ ok: true, equip: aSh.equip }); } // 캐릭터 생성/성별 변경(무료)
        if (itemId !== 'off' && !aSh.items[cat + ':' + itemId]) return res.status(403).json({ error: '보유하지 않은 아이템' });
        if (cat === 'nick' && itemId !== 'off') { // 💬 기본 수식어: 최대 2개, 같은 걸 다시 보내면 해제(토글)
          var arrN = Array.isArray(aSh.equip.nick) ? aSh.equip.nick.slice() : (aSh.equip.nick ? [aSh.equip.nick] : []);
          if (arrN.indexOf(itemId) >= 0) arrN = arrN.filter(function (x) { return x !== itemId; });
          else { arrN.push(itemId); if (arrN.length > 2) arrN.shift(); }
          if (arrN.length) aSh.equip.nick = arrN; else delete aSh.equip.nick;
          await putAcct(aSh);
          return res.status(200).json({ ok: true, equip: aSh.equip });
        }
        if (itemId === 'off') delete aSh.equip[cat];
        else if (cat === 'title') {
          var tx = String(body.text || '').slice(0, 12).trim();
          if (!tx) return res.status(400).json({ error: '칭호 문구(12자) 입력' });
          aSh.equip.title = tx;
        } else aSh.equip[cat] = itemId;
        await putAcct(aSh);
        return res.status(200).json({ ok: true, equip: aSh.equip });
      }
    }

    // ═══ 🎪 오락실 — 카지노 논리: 유료 게임은 기대값 마이너스, 복구는 내전·배당으로 ═══
    function pickWeighted(table) { // [[값, 퍼센트], ...] 합 100
      var r = Math.random() * 100, acc = 0;
      for (var i = 0; i < table.length; i++) { acc += table[i][1]; if (r < acc) return table[i][0]; }
      return table[table.length - 1][0];
    }
    // 🎰 데일리 룰렛 (무료 1회, 7일 연속 출석 시 2회) — 출석의 변동 보상화
    if (req.method === 'POST' && action === 'spin') {
      var sSp = await auth(body.token);
      if (!sSp || !sSp.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var aSp = await getAcct(sSp.name);
      if (!aSp || aSp.status !== 'active') return res.status(403).json({ error: '계좌 상태 확인' });
      var dSp = kstDate();
      var maxSpin = (Number(aSp.streak) || 0) >= 7 ? 2 : 1;
      var used = Number(await redis(['INCRBY', 'spin:' + dSp + ':' + aSp.name, '1']));
      await redis(['EXPIRE', 'spin:' + dSp + ':' + aSp.name, '93600']);
      if (used > maxSpin) return res.status(429).json({ error: '오늘 스핀 소진! ' + (maxSpin === 1 ? '7일 연속 출석하면 하루 2회' : '내일 또 만나요') });
      var prize = pickWeighted([[50, 55], [150, 30], [300, 10], [600, 4], [5000, 1]]);
      aSp.bal += prize;
      await putAcct(aSp);
      await ledger(aSp.name, prize >= 5000 ? '🎰💥 룰렛 잭팟!!' : '🎰 데일리 룰렛', prize, aSp.bal);
      if (prize >= 5000) { await redis(['LPUSH', 'arcade:news', JSON.stringify({ n: aSp.name, t: 'spin', v: prize, ts: new Date().toISOString() })]); await redis(['LTRIM', 'arcade:news', '0', '9']); }
      return res.status(200).json({ ok: true, prize: prize, bal: aSp.bal, left: maxSpin - used });
    }
    // 🎟 스크래치 복권 (300 APO, 하루 3장, 환급 ~85% + 손실 10% 잭팟 적립)
    if (req.method === 'POST' && action === 'scratch') {
      var sSc2 = await auth(body.token);
      if (!sSc2 || !sSc2.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var aSc = await getAcct(sSc2.name);
      if (!aSc || aSc.status !== 'active') return res.status(403).json({ error: '계좌 상태 확인' });
      if (aSc.bal < 300) return res.status(400).json({ error: '복권은 300 APO' });
      var dSc = kstDate();
      var nSc = Number(await redis(['INCRBY', 'scr:' + dSc + ':' + aSc.name, '1']));
      await redis(['EXPIRE', 'scr:' + dSc + ':' + aSc.name, '93600']);
      if (nSc > 3) return res.status(429).json({ error: '복권은 하루 3장까지! (도박은 적당히 🙏)' });
      aSc.bal -= 300;
      await redis(['SET', 'arcade:jackpot', '1000', 'NX']); // 시드 1,000 보장
      await redis(['INCRBY', 'arcade:jackpot', '30']); // 판매액 10% 적립
      var pz = pickWeighted([[0, 55], [100, 20], [300, 15], [600, 7], [1500, 2.7], ['JP', 0.3]]);
      var wonJp = 0;
      if (pz === 1500) { await redis(['LPUSH', 'arcade:news', JSON.stringify({ n: aSc.name, t: 'scr', v: 1500, ts: new Date().toISOString() })]); await redis(['LTRIM', 'arcade:news', '0', '9']); } // 🎫 복권 1등 속보
      if (pz === 'JP') {
        wonJp = Number(await redis(['GET', 'arcade:jackpot'])) || 1000;
        await redis(['SET', 'arcade:jackpot', '1000']); // 시드 리셋
        pz = wonJp;
        await redis(['LPUSH', 'arcade:news', JSON.stringify({ n: aSc.name, t: 'jp', v: wonJp, ts: new Date().toISOString() })]);
        await redis(['LTRIM', 'arcade:news', '0', '9']);
      }
      if (pz > 0) aSc.bal += pz;
      await putAcct(aSc);
      await ledger(aSc.name, wonJp ? '🎟💥 복권 잭팟!! 누적 풀 전액' : '🎟 스크래치 복권', pz - 300, aSc.bal);
      return res.status(200).json({ ok: true, prize: pz, jackpot: !!wonJp, bal: aSc.bal, left: 3 - nSc });
    }
    // 🃏 하이로우 더블 (100~2,000, 승률 47.5% — 하우스 엣지 5%)
    if (req.method === 'POST' && action === 'highlow') {
      var sHL = await auth(body.token);
      if (!sHL || !sHL.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var aHL = await getAcct(sHL.name);
      if (!aHL || aHL.status !== 'active') return res.status(403).json({ error: '계좌 상태 확인' });
      var amtH = Math.round(Number(body.amount) || 0);
      if (amtH < 100 || amtH > 2000) return res.status(400).json({ error: '판돈은 100~2,000 APO' });
      if (aHL.bal < amtH) return res.status(400).json({ error: '잔액 부족' });
      var dHL = kstDate();
      var nHL = Number(await redis(['INCRBY', 'hl:' + dHL + ':' + aHL.name, '1']));
      await redis(['EXPIRE', 'hl:' + dHL + ':' + aHL.name, '93600']);
      if (nHL > 20) return res.status(429).json({ error: '하이로우는 하루 20판까지! 내일 복수전 🙏' });
      if (!(await acctLock(sHL.name))) return res.status(429).json({ error: '처리 중 — 잠시 후 다시' });
      try {
      aHL = (await getAcct(sHL.name)) || aHL;
      if (aHL.bal < amtH) return res.status(400).json({ error: '잔액 부족' });
      var winH = Math.random() < 0.475;
      aHL.bal += winH ? amtH : -amtH;
      aHL = await busted(aHL);
      await putAcct(aHL);
      await ledger(aHL.name, winH ? '🃏 하이로우 승! ×2' : '🃏 하이로우 패…', winH ? amtH : -amtH, aHL.bal);
      return res.status(200).json({ ok: true, win: winH, bal: aHL.bal, left: 20 - nHL });
      } finally { await acctUnlock(sHL.name); }
    }
    // 잭팟 풀·속보 조회
    if (req.method === 'GET' && action === 'arcade') {
      var jp = Number(await redis(['GET', 'arcade:jackpot'])) || 1000;
      var nw = ((await redis(['LRANGE', 'arcade:news', '0', '4'])) || []).map(function (x) { try { return JSON.parse(x) } catch (e) { return null } }).filter(Boolean);
      return res.status(200).json({ jackpot: jp, news: nw });
    }
    // 📋 주간 미션 — 전부 자동 체크 (행동 시 서버가 카운트)
    function weekIdOf() { var w = new Date(); return w.getUTCFullYear() + '-W' + Math.ceil(((w - new Date(Date.UTC(w.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7); }
    if (req.method === 'GET' && action === 'missions') {
      var sM2 = await auth(q.token);
      if (!sM2 || !sM2.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var wkM = weekIdOf();
      var flatM = (await redis(['HGETALL', 'msn:' + wkM + ':' + sM2.name])) || [];
      var cnt = {}; for (var fm = 0; fm + 1 < flatM.length; fm += 2) cnt[flatM[fm]] = Number(flatM[fm + 1]) || 0;
      var claimed = (await redis(['SMEMBERS', 'mcl:' + wkM + ':' + sM2.name])) || [];
      return res.status(200).json({ week: wkM, count: cnt, claimed: claimed });
    }
    if (req.method === 'POST' && action === 'missionClaim') {
      var sMC = await auth(body.token);
      if (!sMC || !sMC.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var MDEF = { play: { need: 1, pay: 500 }, bet: { need: 2, pay: 200 }, trade: { need: 1, pay: 200 }, vote: { need: 1, pay: 100 }, all: { need: 0, pay: 1000 } };
      var fld = String(body.field || '');
      if (!MDEF[fld]) return res.status(400).json({ error: '없는 미션' });
      var wkC = weekIdOf();
      var flatC = (await redis(['HGETALL', 'msn:' + wkC + ':' + sMC.name])) || [];
      var cc = {}; for (var fc = 0; fc + 1 < flatC.length; fc += 2) cc[flatC[fc]] = Number(flatC[fc + 1]) || 0;
      var doneAll = ['play', 'bet', 'trade', 'vote'].every(function (k) { return (cc[k] || 0) >= MDEF[k].need; });
      if (fld === 'all' ? !doneAll : (cc[fld] || 0) < MDEF[fld].need) return res.status(400).json({ error: '아직 달성 전이에요' });
      var firstC = await redis(['SADD', 'mcl:' + wkC + ':' + sMC.name, fld]);
      await redis(['EXPIRE', 'mcl:' + wkC + ':' + sMC.name, SEC90]);
      if (Number(firstC) !== 1) return res.status(409).json({ error: '이미 받았어요 (주 1회)' });
      var aMC = await getAcct(sMC.name);
      aMC.bal += MDEF[fld].pay;
      await putAcct(aMC);
      await ledger(aMC.name, '📋 주간 미션 보상 — ' + fld, MDEF[fld].pay, aMC.bal);
      return res.status(200).json({ ok: true, field: fld, pay: MDEF[fld].pay, bal: aMC.bal });
    }

    // ═══ 🏅 MVP 온라인 투표 (계정 1인 1표) ═══
    if (req.method === 'GET' && action === 'mvpTally') {
      var dM = String(q.date || '');
      if (!mktOk(dM)) return res.status(400).json({ error: 'date 형식: YYYY-MM-DD (#회차 허용)' });
      var stM = (await redis(['GET', 'mvp:' + dM + ':status'])) || 'open';
      var flat = (await redis(['HGETALL', 'mvp:' + dM + ':t'])) || [];
      var tal = {};
      for (var fm = 0; fm + 1 < flat.length; fm += 2) tal[flat[fm]] = Number(flat[fm + 1]) || 0;
      var myPick = null;
      var sMv = await auth(q.token);
      if (sMv && sMv.name) myPick = await redis(['GET', 'mvp:' + dM + ':v:' + sMv.name]);
      var untilM = Number(await redis(['GET', 'mvp:' + dM + ':until'])) || 0;
      if (untilM && Date.now() > untilM && stM === 'open') { stM = 'locked'; await redis(['SET', 'mvp:' + dM + ':status', 'locked', 'EX', SEC90]); } // ⏱ 타이머 만료 = 자동 마감
      return res.status(200).json({ date: dM, status: stM, tally: tal, my: myPick, until: untilM });
    }
    if (req.method === 'POST' && action === 'mvpVote') {
      var sV = await auth(body.token);
      if (!sV || !sV.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var dV = String(body.date || ''), pk = nameOk(body.pick);
      if (!mktOk(dV)) return res.status(400).json({ error: 'date 형식 오류' });
      if (!pk) return res.status(400).json({ error: '후보 이름 확인' });
      var stV = (await redis(['GET', 'mvp:' + dV + ':status'])) || 'open';
      var untilV0 = Number(await redis(['GET', 'mvp:' + dV + ':until'])) || 0;
      if (untilV0 && Date.now() > untilV0) return res.status(400).json({ error: '⏱ 투표 시간이 끝났어요 — 결과 확정!' });
      if (stV !== 'open') return res.status(403).json({ error: 'MVP 투표가 마감됐어요' });
      var firstV = await redis(['SET', 'mvp:' + dV + ':v:' + sV.name, pk, 'NX', 'EX', SEC90]);
      if (firstV !== 'OK') return res.status(409).json({ error: '이미 투표했어요' });
      await redis(['HINCRBY', 'mvp:' + dV + ':t', pk, '1']);
      await redis(['EXPIRE', 'mvp:' + dV + ':t', SEC90]);
      await redis(['HINCRBY', 'msn:' + (new Date().getUTCFullYear() + '-W' + Math.ceil(((new Date() - new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7)) + ':' + sV.name, 'vote', '1']);
      return res.status(200).json({ ok: true, pick: pk });
    }
    // ── 🎁 운영진 특별 이벤트: 회장 주3회(총 1,000) · 부회장 주1회(총 500) — 선착순 봉투 ──
    function bareSrv(n) { return String(n || '').replace(/^\d+\s*/, '').trim(); }
    var EV_QUOTA = { '물방울': { role: '회장', per: 3, cap: 1000 }, '미르': { role: '부회장', per: 1, cap: 500 } };
    async function evList() { try { return JSON.parse((await redis(['GET', 'events:list'])) || '[]'); } catch (e) { return []; } }
    async function evSave(l) { await redis(['SET', 'events:list', JSON.stringify(l.slice(-6)), 'EX', SEC90]); }
    if (req.method === 'GET' && action === 'events') {
      var lE = (await evList()).filter(function (e) { return Date.now() - e.ts < 7 * 86400000; });
      var quota = null;
      var sE0 = await auth(q.token);
      if (sE0 && sE0.name) {
        var bq = EV_QUOTA[bareSrv(sE0.name)];
        if (bq) { var wkQ = Math.floor(Date.now() / 604800000); quota = { role: bq.role, per: bq.per, cap: bq.cap, used: Number(await redis(['GET', 'ev:q:' + wkQ + ':' + bareSrv(sE0.name)])) || 0 }; }
      }
      return res.status(200).json({ events: lE, quota: quota });
    }
    if (req.method === 'POST' && action === 'eventCreate') {
      var sE = await auth(body.token);
      if (!sE || !sE.name) return res.status(401).json({ error: '로그인이 필요해요' });
      var bE = bareSrv(sE.name), QE = EV_QUOTA[bE];
      if (!QE) return res.status(403).json({ error: '회장·부회장만 이벤트를 열 수 있어요' });
      var tE = String(body.title || '').trim().slice(0, 24);
      var payE = Math.round(Number(body.pay) || 0), slotE = Math.round(Number(body.slots) || 0);
      if (!tE) return res.status(400).json({ error: '이벤트 이름을 입력해주세요' });
      if (payE < 50) return res.status(400).json({ error: '1인당 50 APO 이상' });
      if (slotE < 1 || slotE > 30) return res.status(400).json({ error: '인원은 1~30명' });
      if (payE * slotE > QE.cap) return res.status(400).json({ error: '총 지급액(' + (payE * slotE) + ')이 ' + QE.role + ' 한도 ' + QE.cap + ' APO를 넘어요' });
      var wkE = Math.floor(Date.now() / 604800000);
      var usedE = Number(await redis(['INCRBY', 'ev:q:' + wkE + ':' + bE, '1']));
      await redis(['EXPIRE', 'ev:q:' + wkE + ':' + bE, '1209600']);
      if (usedE > QE.per) { await redis(['INCRBY', 'ev:q:' + wkE + ':' + bE, '-1']); return res.status(429).json({ error: '이번 주 ' + QE.role + ' 이벤트 횟수(' + QE.per + '회)를 다 썼어요' }); }
      var lC = await evList();
      lC.push({ id: 'e' + Date.now().toString(36), by: bE, role: QE.role, title: tE, pay: payE, slots: slotE, got: [], ts: Date.now() });
      await evSave(lC);
      return res.status(200).json({ ok: true, left: QE.per - usedE });
    }
    if (req.method === 'POST' && action === 'eventJoin') {
      if (!(await acctLock('evj:' + String(body.id || '')))) return res.status(429).json({ error: '처리 중 — 잠시 후 다시' });
      try {
        var sJ = await auth(body.token);
        if (!sJ || !sJ.name) return res.status(401).json({ error: '로그인이 필요해요' });
        var lJ = await evList();
        var evJ = lJ.find(function (e) { return e.id === String(body.id || ''); });
        if (!evJ) return res.status(404).json({ error: '이벤트가 없어요' });
        if (evJ.got.indexOf(sJ.name) >= 0) return res.status(409).json({ error: '이미 받았어요!' });
        if (evJ.got.length >= evJ.slots) return res.status(400).json({ error: '선착순 마감!' });
        var aJ = await getAcct(sJ.name);
        if (!aJ || aJ.status !== 'active') return res.status(403).json({ error: '계좌 상태 확인' });
        aJ.bal += evJ.pay;
        evJ.got.push(sJ.name);
        await putAcct(aJ);
        await evSave(lJ);
        await ledger(aJ.name, '🎁 ' + evJ.role + ' ' + evJ.by + ' 이벤트: ' + evJ.title, evJ.pay, aJ.bal);
        return res.status(200).json({ ok: true, bal: aJ.bal, left: evJ.slots - evJ.got.length });
      } finally { await acctUnlock('evj:' + String(body.id || '')); }
    }

    // ── ⏱ MVP 투표 타이머 (운영진: N분 뒤 자동 마감) ──
    if (req.method === 'POST' && action === 'mvpTimer') {
      var sT9 = await auth(body.token);
      if (!sT9 || (sT9.role !== 'admin' && sT9.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var dT9 = String(body.date || '');
      if (!mktOk(dT9)) return res.status(400).json({ error: 'date 형식 오류' });
      var minT = Math.round(Number(body.minutes) || 0);
      if (minT < 1 || minT > 240) return res.status(400).json({ error: '타이머는 1~240분' });
      var untilT = Date.now() + minT * 60000;
      await redis(['SET', 'mvp:' + dT9 + ':until', String(untilT), 'EX', SEC90]);
      await redis(['SET', 'mvp:' + dT9 + ':status', 'open', 'EX', SEC90]);
      return res.status(200).json({ ok: true, until: untilT });
    }
    // ── 🗑 MVP 투표 초기화 (운영진: 해당 회차만 전체 리셋) ──
    if (req.method === 'POST' && action === 'mvpReset') {
      var sR9 = await auth(body.token);
      if (!sR9 || (sR9.role !== 'admin' && sR9.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var dR9 = String(body.date || '');
      if (!mktOk(dR9)) return res.status(400).json({ error: 'date 형식 오류' });
      await redis(['DEL', 'mvp:' + dR9 + ':t']);
      await redis(['DEL', 'mvp:' + dR9 + ':until']);
      await redis(['SET', 'mvp:' + dR9 + ':status', 'open', 'EX', SEC90]);
      var allR9 = (await redis(['SMEMBERS', 'acct:_all'])) || [];
      for (var r9 = 0; r9 < allR9.length; r9++) await redis(['DEL', 'mvp:' + dR9 + ':v:' + allR9[r9]]); // 1인 1표 기록도 리셋 → 재투표 가능
      return res.status(200).json({ ok: true, cleared: allR9.length });
    }
    if (req.method === 'POST' && action === 'mvpLock') {
      var sVL = await auth(body.token);
      if (!sVL || (sVL.role !== 'admin' && sVL.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var dVL = String(body.date || '');
      if (!mktOk(dVL)) return res.status(400).json({ error: 'date 형식 오류' });
      await redis(['SET', 'mvp:' + dVL + ':status', body.open ? 'open' : 'locked', 'EX', SEC90]);
      if (body.open) await redis(['DEL', 'mvp:' + dVL + ':until']); // 재개하면 지난 타이머는 해제
      return res.status(200).json({ ok: true });
    }

    // ═══ 공개: 실시간 체결 테이프 ═══
    if (req.method === 'GET' && action === 'trades') {
      var tp = (await redis(['LRANGE', 'trades:recent', '0', '29'])) || [];
      return res.status(200).json({ trades: tp.map(function (x) { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) });
    }
    // ═══ 공개: 종목 가격 히스토리 (차트) ═══
    if (req.method === 'GET' && action === 'pxhist') {
      var tg = nameOk(q.target);
      if (!tg) return res.status(400).json({ error: 'target 필요' });
      var hh2 = (await redis(['LRANGE', 'pxh:' + tg, '0', '59'])) || [];
      var arr = hh2.map(function (x) { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean).reverse();
      return res.status(200).json({ target: tg, hist: arr });
    }

    // ═══ 계정 정리: 삭제 / 파산 기록 초기화 (운영진·개발자) ═══
    if (req.method === 'POST' && (action === 'purge' || action === 'clearBust')) {
      var sC = await auth(body.token);
      if (!sC || (sC.role !== 'admin' && sC.role !== 'dev')) return res.status(403).json({ error: '권한 없음' });
      var nmC = nameOk(body.name);
      var aC = nmC ? await getAcct(nmC) : null;
      if (!aC) return res.status(404).json({ error: '계정을 못 찾았어요' });
      if (action === 'purge') {
        await redis(['DEL', 'acct:' + aC.name]);
        await redis(['DEL', 'hold:' + aC.name]);
        await redis(['DEL', 'ledger:' + aC.name]);
        await redis(['SREM', 'acct:_all', aC.name]);
        return res.status(200).json({ ok: true, purged: aC.name });
      }
      aC.bust = 0; aC.lastBustAt = ''; aC.lastBustDay = '';
      await putAcct(aC);
      return res.status(200).json({ ok: true, name: aC.name });
    }

    // ═══ 공개 장부: 베팅 현황 (누가 어디에 얼마) ═══
    if (req.method === 'GET' && action === 'bets') {
      var mkB = String(q.market || '');
      if (!mktOk(mkB)) return res.status(400).json({ error: 'market 형식 오류' });
      var bn = (await redis(['SMEMBERS', 'mkt:' + mkB + ':bettors'])) || [];
      var listB = [];
      for (var b2 = 0; b2 < bn.length; b2++) {
        var bRaw2 = await redis(['GET', 'bet:' + mkB + ':' + bn[b2]]);
        if (!bRaw2) continue;
        var bo = JSON.parse(bRaw2);
        listB.push({ name: bn[b2], team: bo.team, amt: bo.amt, allin: !!bo.allin });
      }
      listB.sort(function (x, y) { return y.amt - x.amt; });
      return res.status(200).json({ market: mkB, bets: listB });
    }

    // ═══ 공개 장부: 주주 명부 (누가 누구 주식을 몇 주) ═══
    if (req.method === 'GET' && action === 'holders') {
      var allN = (await redis(['SMEMBERS', 'acct:_all'])) || [];
      var map = {};
      var holdRaws = allN.length ? (await redis(['MGET'].concat(allN.map(function (n) { return 'hold:' + n; })))) || [] : []; // 🐛fix: N+1 → MGET
      for (var h2 = 0; h2 < allN.length; h2++) {
        var hR = holdRaws[h2];
        if (!hR) continue;
        var hh = JSON.parse(hR);
        for (var tgt2 in hh) {
          if (!map[tgt2]) map[tgt2] = [];
          map[tgt2].push({ owner: allN[h2], q: hh[tgt2].q });
        }
      }
      for (var t3 in map) map[t3].sort(function (x, y) { return y.q - x.q; });
      return res.status(200).json({ holders: map });
    }

    return res.status(400).json({ error: '알 수 없는 요청: ' + action });
  } catch (e) {
    return res.status(500).json({ error: '서버 오류: ' + (e && e.message ? e.message : String(e)) });
  }
};
