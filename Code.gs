/**
 * 火災警報等判定ダッシュボード 記録用GAS（大垣市・池田町）
 *
 * 設計方針：
 *   GASが10分ごとに気象庁データを全て取得・判定・整形してスプレッドシートに記録。
 *   HTML側はこのGASの doGet?action=current を呼ぶだけ。JMAへの直接アクセス不要。
 *
 * 初回手順：
 *   1. このCode.gsをApps Scriptに貼り付ける
 *   2. SPREADSHEET_IDを記入（スプレッドシート紐付け時は空欄可）
 *   3. initializeSheets() を1回実行
 *   4. createTenMinuteTrigger() を1回実行
 *   5. collectWeatherData() を手動実行して確認
 *   6. デプロイ > 新しいデプロイ > ウェブアプリ > 全員がアクセス可 で公開
 */

const CONFIG = {
  SPREADSHEET_ID: '',
  TZ: 'Asia/Tokyo',
  JMA_WARNING_URL:  'https://www.jma.go.jp/bosai/warning/data/r8/210000.json',
  JMA_TIMELINE_URL: 'https://www.jma.go.jp/bosai/warning_timeline/data/210000.json',
  JMA_FORECAST_URL: 'https://www.jma.go.jp/bosai/forecast/data/forecast/210000.json',
  EFFECTIVE_HUMIDITY_R: 0.7,
  STATIONS: [
    { name: '大垣市', prec_no: '52', block_no: '0496', area_code: '2120200',
      amedas_no: '52581', amedas_name: '大垣（大垣市禾森町）', note: '観測地点: 大垣' },
    { name: '池田町', prec_no: '52', block_no: '1301', area_code: '2140400',
      amedas_no: '52511', amedas_name: '揖斐川（揖斐郡揖斐川町三輪）', note: '観測地点: 揖斐川' }
  ]
};

const SHEETS = { CURRENT: '現在状況', LOG_PREFIX: '履歴_', SETTINGS: '設定', ERROR: 'エラーログ' };

// ヘッダー定義（新規追加列：wind10minHistoryJSON, effStepsJSON, forecastSlotsJSON, dailyRainJSON）
const CURRENT_HEADERS = [
  '更新日時', '観測時刻', '市町名', '観測地点',
  '前3日降水量mm', '前30日降水量mm', '当日降水量mm',
  '平均湿度%', '最小湿度%', '実効湿度%',
  '最大風速m/s', '最新10分風速m/s', '予報最大風速m/s',
  '乾燥注意報', '強風注意報', '発表中注意報警報',
  '林野火災判定', '火災警報判定', '判定理由',
  '10m/s連続回数', '12m/s連続回数', '取得状態', '診断', '観測キー',
  // HTML表示用の詳細JSON（新規追加）
  'wind10minHistoryJSON', 'effStepsJSON', 'forecastSlotsJSON', 'dailyRainJSON',
  '予報最大発表時刻'
];
const LOG_HEADERS = CURRENT_HEADERS;
const ERROR_HEADERS = ['日時', '処理', '市町名', 'エラー内容', '詳細'];
const SETTINGS_HEADERS = ['市町名','府県番号','観測所番号','市町村コード','アメダス番号','アメダス地点名','備考'];

const WARNING_NAMES = {
  '33':'大雨特別警報','03':'大雨警報','10':'大雨注意報','04':'洪水警報','18':'洪水注意報',
  '35':'暴風特別警報','05':'暴風警報','15':'強風注意報',
  '32':'暴風雪特別警報','02':'暴風雪警報','13':'風雪注意報',
  '36':'大雪特別警報','06':'大雪警報','12':'大雪注意報',
  '37':'波浪特別警報','07':'波浪警報','16':'波浪注意報',
  '38':'高潮特別警報','08':'高潮警報','19':'高潮注意報',
  '14':'雷注意報','17':'融雪注意報','20':'濃霧注意報','21':'乾燥注意報',
  '22':'なだれ注意報','23':'低温注意報','24':'霜注意報','25':'着氷注意報','26':'着雪注意報'
};

// ============================================================
// シート管理
// ============================================================
function getSs_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function initializeSheets() {
  const ss = getSs_();
  ensureSheet_(ss, SHEETS.CURRENT, CURRENT_HEADERS);
  ensureSheet_(ss, SHEETS.ERROR,   ERROR_HEADERS);
  ensureSheet_(ss, SHEETS.SETTINGS, SETTINGS_HEADERS);
  const set = ss.getSheetByName(SHEETS.SETTINGS);
  set.clearContents();
  set.getRange(1,1,1,7).setValues([SETTINGS_HEADERS]);
  set.getRange(2,1,CONFIG.STATIONS.length,7).setValues(
    CONFIG.STATIONS.map(s => [s.name,s.prec_no,s.block_no,s.area_code,s.amedas_no,s.amedas_name,s.note])
  );
  ensureSheet_(ss, getLogSheetName_(), LOG_HEADERS);
}

function createTenMinuteTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'collectWeatherData')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('collectWeatherData').timeBased().everyMinutes(10).create();
}

// ============================================================
// メイン収集処理
// ============================================================
function collectWeatherData() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    initializeSheetsIfNeeded_();
    const ss  = getSs_();
    const now = new Date();
    const nowStr = fmt_(now, 'yyyy/MM/dd HH:mm:ss');

    // 警報JSON・予報タイムライン（全地域共通）
    const warningsJson = fetchJson_(CONFIG.JMA_WARNING_URL);
    const timelineJson = safeFetchJson_(CONFIG.JMA_TIMELINE_URL);

    const rows = [], logRows = [];
    for (const station of CONFIG.STATIONS) {
      try {
        // 前30日日別降水量
        const daily = fetchLast30Daily_(station);
        const rain3  = round1_(daily.slice(-3).reduce((s,d) => s + (d.rain || 0), 0));
        const rain30 = round1_(daily.reduce((s,d) => s + (d.rain || 0), 0));
        // 日別降水量をJSON化（HTML側の棒グラフ・テーブル用）
        const dailyRainJSON = JSON.stringify(daily.map(d => ({ dateStr: d.dateStr, rain: d.rain })));

        // 警報・注意報
        const warnings     = parseWarnings_(warningsJson, station.area_code);
        // 予報スロット
        const timeline     = parseTimelineWind_(timelineJson, station.area_code);
        const forecastLevel = timeline.maxWind || windForecastTextLevel_(timeline.forecastText || '');
        const forecastSlotsJSON = JSON.stringify(timeline.slots || []);
        const forecastReportDt  = timeline.reportDatetime || '';

        // アメダスリアルタイム
        const amedas = fetchAmedasToday_(station.amedas_no);

        // 実効湿度
        const humAvgs = daily.map(d => d.humAvg);
        if (amedas.humAvg != null) humAvgs.push(amedas.humAvg);
        const effHum   = effectiveHumidity_(humAvgs);
        const effSteps = effectiveHumiditySteps_(humAvgs, daily, amedas.humAvg);
        const effStepsJSON = JSON.stringify(effSteps);

        // 風速
        const etrnToday    = daily[daily.length - 1] || {};
        const minHum       = amedas.humMin   != null ? amedas.humMin   : etrnToday.humMin;
        const hourlyWindMax= amedas.windMax  != null ? amedas.windMax  : etrnToday.windMax;
        const latest10min  = amedas.latestWind10min;
        const windMax      = maxNullable_(hourlyWindMax, latest10min);
        const rainToday    = amedas.rainToday != null ? amedas.rainToday : etrnToday.rain;
        const streak10     = calcStreak_(amedas.wind10minHistory, 10);
        const streak12     = calcStreak_(amedas.wind10minHistory, 12);

        // 10分履歴JSON（HTML側の折りたたみ表示用）
        const wind10minHistoryJSON = JSON.stringify(amedas.wind10minHistory || []);

        // 判定
        const forestVerdict = forestJudge_(rain3, rain30, warnings.kanso, warnings.kyofu);
        const fire          = fireWarningJudge_(rainToday, minHum, effHum, latest10min, forecastLevel);
        const obsKey        = `${station.area_code}_${amedas.latestKey || fmt_(now, 'yyyyMMddHHmm')}`;
        const status        = amedas._error ? '一部取得失敗' : '正常';
        const diag          = amedas._diagMsg || '';

        const row = [
          nowStr,
          amedas.obsTime || '',
          station.name,
          station.amedas_name,
          rain3, rain30, rainToday,
          amedas.humAvg, minHum,
          effHum != null ? round1_(effHum) : '',
          windMax, latest10min, forecastLevel || '',
          warnings.kanso ? 'あり' : 'なし',
          warnings.kyofu ? 'あり' : 'なし',
          warnings.all.join('・'),
          forestVerdict, fire.result, fire.note,
          streak10, streak12, status, diag, obsKey,
          // 新規追加列
          wind10minHistoryJSON, effStepsJSON, forecastSlotsJSON, dailyRainJSON,
          forecastReportDt
        ];
        rows.push(row);

        const propKey = `LAST_OBS_KEY_${station.area_code}`;
        const lastKey = PropertiesService.getScriptProperties().getProperty(propKey);
        if (lastKey !== obsKey) {
          logRows.push(row);
          PropertiesService.getScriptProperties().setProperty(propKey, obsKey);
        }
      } catch (e) {
        appendError_('collectWeatherData', station.name, e, '地点処理');
      }
    }

    writeCurrent_(ss, rows);
    if (logRows.length) appendLog_(ss, logRows);
    PropertiesService.getScriptProperties().setProperty('LAST_SUCCESS', nowStr);
  } catch (e) {
    appendError_('collectWeatherData', '', e, '全体処理');
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// Web API
// ============================================================
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'current';
  try {
    if (action === 'collect') {
      collectWeatherData();
      return json_({ ok: true, message: 'collect done' });
    }
    if (action === 'log') return json_(readSheetAsJson_(getLogSheetName_(), 500));
    const rows = readCurrent_();
    const latestUpdated = rows.length > 0 && rows[0]['更新日時']
      ? rows[0]['更新日時']
      : (PropertiesService.getScriptProperties().getProperty('LAST_SUCCESS') || '');
    return json_({ ok: true, updated: latestUpdated, data: rows });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ============================================================
// シートヘルパー
// ============================================================
function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const current = sh.getRange(1,1,1,headers.length).getValues()[0];
  if (current.join('') === '') sh.getRange(1,1,1,headers.length).setValues([headers]);
  return sh;
}

function initializeSheetsIfNeeded_() {
  const ss = getSs_();
  if (!ss.getSheetByName(SHEETS.CURRENT) || !ss.getSheetByName(SHEETS.ERROR)) initializeSheets();
  ensureSheet_(ss, getLogSheetName_(), LOG_HEADERS);
}

function getLogSheetName_() { return SHEETS.LOG_PREFIX + fmt_(new Date(), 'yyyy_MM'); }

function writeCurrent_(ss, rows) {
  const sh = ensureSheet_(ss, SHEETS.CURRENT, CURRENT_HEADERS);
  sh.clearContents();
  sh.getRange(1,1,1,CURRENT_HEADERS.length).setValues([CURRENT_HEADERS]);
  if (rows.length) sh.getRange(2,1,rows.length,CURRENT_HEADERS.length).setValues(rows);
  sh.autoResizeColumns(1, Math.min(CURRENT_HEADERS.length, 12));
}

function appendLog_(ss, rows) {
  const sh = ensureSheet_(ss, getLogSheetName_(), LOG_HEADERS);
  sh.getRange(sh.getLastRow()+1,1,rows.length,LOG_HEADERS.length).setValues(rows);
}

function appendError_(process, area, e, detail) {
  try {
    const ss = getSs_();
    const sh = ensureSheet_(ss, SHEETS.ERROR, ERROR_HEADERS);
    sh.appendRow([fmt_(new Date(),'yyyy/MM/dd HH:mm:ss'), process, area, String(e && e.message||e), detail||'']);
  } catch(_) {}
}

function readCurrent_() {
  return readSheetAsJson_(SHEETS.CURRENT, 1000).rows || [];
}

function readSheetAsJson_(name, limit) {
  const sh = getSs_().getSheetByName(name);
  if (!sh) return { rows: [] };
  const range   = sh.getDataRange();
  const values  = range.getValues();
  const display = range.getDisplayValues();
  if (values.length < 2) return { rows: [] };
  const headers = values[0];
  const body    = display.slice(1).slice(-limit);
  const parseCell = (s) => {
    if (s === '' || s == null) return '';
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(String(s))) return String(s).slice(0, 5);
    const n = Number(String(s).replace(/,/g, ''));
    return isNaN(n) ? s : n;
  };
  return { rows: body.map(r => Object.fromEntries(headers.map((h,i) => [h, parseCell(r[i])]))) };
}

// ============================================================
// 気象庁データ取得
// ============================================================
function fetchJson_(url) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'Cache-Control': 'no-cache' } });
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) throw new Error(`HTTP ${res.getResponseCode()} ${url}`);
  return JSON.parse(res.getContentText('UTF-8'));
}
function safeFetchJson_(url) { try { return fetchJson_(url); } catch(e) { return null; } }

function fetchText_(url) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'Cache-Control': 'no-cache' } });
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) throw new Error(`HTTP ${res.getResponseCode()} ${url}`);
  return res.getContentText('UTF-8');
}

function fetchLast30Daily_(station) {
  const dates = getLast30Dates_();
  const ymSet = {};
  dates.forEach(d => ymSet[`${d.y}-${d.m}`] = { y: d.y, m: d.m });
  const byDate = {};
  Object.keys(ymSet).forEach(k => {
    const ym = ymSet[k];
    try {
      const url = `https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php?prec_no=${station.prec_no}&block_no=${station.block_no}&year=${ym.y}&month=${ym.m}&day=&view=p1`;
      Object.assign(byDate, parseETRN_(fetchText_(url), ym.y, ym.m));
    } catch (e) {
      appendError_('fetchLast30Daily', station.name, e, `${ym.y}/${ym.m}`);
    }
  });
  return dates.map(d => {
    const rec = byDate[d.dateStr] || {};
    return { ...d, rain: rec.rain != null ? rec.rain : 0, humAvg: nullable_(rec.humAvg), humMin: nullable_(rec.humMin), windMax: nullable_(rec.windMax) };
  });
}

function parseETRN_(html, year, month) {
  const result = {};
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  rows.forEach(row => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripHtml_(m[1]));
    if (cells.length <= 10) return;
    const day = parseInt(cells[0].replace(/\s/g,''), 10);
    if (!day || day < 1 || day > 31) return;
    const d = new Date(year, month - 1, day);
    if (d.getMonth() !== month - 1) return;
    result[toDateStr_(d)] = {
      rain:   numOrNull_(cells[1]) ?? 0,
      humAvg: numOrNull_(cells[7]),
      humMin: numOrNull_(cells[8]),
      windMax:numOrNull_(cells[10])
    };
  });
  return result;
}

function fetchAmedasToday_(amedasNo) {
  const result = { humMin:null, humAvg:null, windMax:null, rainToday:null, obsTime:null,
                   latestWind10min:null, latestKey:null, wind10minHistory:[], _error:false, _diagMsg:'' };
  if (!amedasNo) return { ...result, _error:true, _diagMsg:'amedas_no未設定' };
  try {
    const now     = new Date();
    const ymd     = fmt_(now, 'yyyyMMdd');
    const blockH  = Math.floor(Number(fmt_(now, 'H')) / 3) * 3;
    const nowLimit= new Date(now.getTime() - 10 * 60 * 1000);
    const nowKey  = fmt_(nowLimit, 'yyyyMMddHHmm') + '00';
    const blocks  = [];
    for (let h = 0; h <= blockH; h += 3) blocks.push(h);

    let ok = 0;
    const humValues = [];
    let windMax = null, rainSum = 0, latestKey = null;
    const winds = [];

    blocks.forEach(h => {
      const url = `https://www.jma.go.jp/bosai/amedas/data/point/${amedasNo}/${ymd}_${String(h).padStart(2,'00')}.json`;
      try {
        const data = fetchJson_(url);
        ok++;
        Object.keys(data).forEach(key => {
          if (key.slice(0,8) !== ymd) return;
          if (key > nowKey) return;
          const obs = data[key];
          if (!obs) return;
          if (!latestKey || key > latestKey) latestKey = key;
          if (obs.wind && obs.wind[0] != null)
            winds.push({ key, timeLabel: key.slice(8,10)+':'+key.slice(10,12), wind: obs.wind[0] });
          if (key.slice(10,12) === '00') {
            if (obs.humidity     && obs.humidity[0]      != null) humValues.push(obs.humidity[0]);
            if (obs.wind         && obs.wind[0]          != null) windMax = windMax == null ? obs.wind[0] : Math.max(windMax, obs.wind[0]);
            if (obs.precipitation1h && obs.precipitation1h[0] != null) rainSum += obs.precipitation1h[0];
          }
        });
      } catch(e) { /* 未来・未公開ブロックは無視 */ }
    });
    if (ok === 0) throw new Error('アメダス当日ブロックを取得できません');

    winds.sort((a,b) => a.key.localeCompare(b.key));
    const recent = winds.slice(-8).reverse();
    result.wind10minHistory = recent;
    if (recent.length) result.latestWind10min = recent[0].wind;
    if (humValues.length) {
      result.humMin = Math.min(...humValues);
      result.humAvg = round1_(humValues.reduce((a,b)=>a+b,0) / humValues.length);
    }
    result.windMax   = windMax;
    result.rainToday = round1_(rainSum);
    result.latestKey = latestKey;
    result.obsTime   = latestKey ? latestKey.slice(8,10)+':'+latestKey.slice(10,12) : '';
    result._diagMsg  = `amedas ok=${ok}/${blocks.length} hum=${humValues.length} wind10=${winds.length}`;
  } catch (e) {
    result._error   = true;
    result._diagMsg = String(e.message || e);
  }
  return result;
}

function parseWarnings_(data, areaCode) {
  const out = { kanso:false, kyofu:false, all:[], reportDt:'' };
  out.reportDt = latestReportDatetime_(data);
  const kinds = [];
  const arr = Array.isArray(data) ? data : [data];
  arr.forEach(doc => {
    const items = (((doc || {}).warning || {}).class20Items) || [];
    items.forEach(item => {
      if (String(item.areaCode) === String(areaCode)) (item.kinds || []).forEach(k => kinds.push(k));
    });
  });
  kinds.forEach(k => {
    if (!k.code) return;
    if (k.status && String(k.status).includes('解除')) return;
    const name = WARNING_NAMES[k.code] || `その他(${k.code})`;
    if (!out.all.includes(name)) out.all.push(name);
    if (name.includes('乾燥')) out.kanso = true;
    if (name.includes('強風') || name.includes('暴風')) out.kyofu = true;
  });
  return out;
}

function latestReportDatetime_(data) {
  const arr = Array.isArray(data) ? data : [data];
  return arr.map(x => x && (x.reportDatetime || x.reportDateTime || x.reportTime)).filter(Boolean).sort().pop() || '';
}

function parseTimelineWind_(data, areaCode) {
  const result = { maxWind:null, slots:[], forecastText:'', reportDatetime:'' };
  if (!data) return result;
  try {
    const ts = Array.isArray(data.timeSeries) ? data.timeSeries[0] : null;
    if (!ts) return result;
    result.reportDatetime = data.reportDatetime || '';
    const timeDefines = (ts.timeDefines || []).map(t => t.dateTime || t);
    const areaItem = (ts.class20Items || []).find(item => String(item.areaCode) === String(areaCode));
    if (!areaItem) return result;
    let windValues = null;
    (areaItem.kinds || []).forEach(kind => (kind.forecastParts || []).forEach(fp => {
      if (fp.type === '最大風速' && fp.locals && fp.locals[0] && fp.locals[0].values) windValues = fp.locals[0].values;
    }));
    if (!windValues) return result;
    const now = new Date();
    for (let i=0; i<timeDefines.length; i++) {
      const t = new Date(timeDefines[i]);
      if (t < now) continue;
      const raw  = windValues[i] && windValues[i].value;
      const wind = raw !== '--' && raw !== '' && raw != null ? parseFloat(raw) : null;
      const h    = t.getHours(), hEnd = h + 3;
      result.slots.push({ timeLabel: `${String(h).padStart(2,'0')}-${String(hEnd).padStart(2,'0')}時`, wind });
      if (wind != null) result.maxWind = result.maxWind == null ? wind : Math.max(result.maxWind, wind);
    }
  } catch(_) {}
  return result;
}

// ============================================================
// 判定ロジック
// ============================================================
function windForecastTextLevel_(s) {
  if (!s) return 0;
  if (s.indexOf('非常に強') !== -1) return 12;
  if (s.indexOf('やや強')   !== -1) return 10;
  if (s.indexOf('強')       !== -1) return 12;
  return 0;
}

function effectiveHumidity_(avgHums) {
  let he = null;
  avgHums.forEach(a => {
    if (a == null || a === '') return;
    if (he == null) he = Number(a);
    else he = (1 - CONFIG.EFFECTIVE_HUMIDITY_R) * Number(a) + CONFIG.EFFECTIVE_HUMIDITY_R * he;
  });
  return he == null ? null : round1_(he);
}

// 実効湿度計算ステップ詳細（HTML表示用、直近10件）
function effectiveHumiditySteps_(avgHums, days, amedasHumAvg) {
  const r = CONFIG.EFFECTIVE_HUMIDITY_R;
  const steps = [];
  let He = null;
  const hasToday = amedasHumAvg != null && avgHums.length > days.length;
  for (let i = 0; i < avgHums.length; i++) {
    const a = avgHums[i];
    const isToday = hasToday && i === avgHums.length - 1;
    const dateStr = isToday ? '当日(アメダス)' : (days[i] ? days[i].dateStr : '');
    if (He === null) {
      if (a !== null && a !== '') {
        He = Number(a);
        steps.push({ dateStr, humAvg: a, prevHe: null, newHe: round1_(He), isToday, skipped: false });
      }
    } else {
      const prevHe = round1_(He);
      if (a !== null && a !== '') {
        He = (1 - r) * Number(a) + r * He;
        steps.push({ dateStr, humAvg: a, prevHe, newHe: round1_(He), isToday, skipped: false });
      } else {
        steps.push({ dateStr, humAvg: null, prevHe, newHe: round1_(He), isToday, skipped: true });
      }
    }
  }
  return steps.slice(-10);
}

function forestJudge_(rain3, rain30, kanso, kyofu) {
  const c1 = rain3 <= 1.0 && rain30 <= 30.0;
  const c2 = rain3 <= 1.0 && kanso;
  if (!c1 && !c2) return '発令なし';
  if (kyofu) return '警報';
  return '注意報';
}

function fireWarningJudge_(rainToday, minHum, effHum, latest10minWind, forecastLevel) {
  if (minHum == null || effHum == null) return { result:'判定不可', note:'湿度が欠測のため判定できません' };
  const fcLv  = typeof forecastLevel === 'number' ? forecastLevel : 0;
  const obs   = latest10minWind != null ? latest10minWind : null;
  const wind10 = (obs != null && obs >= 10) || fcLv >= 10;
  const wind12 = (obs != null && obs >= 12) || fcLv >= 12;
  const kijun1 = effHum <= 60 && minHum <= 40 && wind10;
  const kijun2 = wind12;
  if (!kijun1 && !kijun2) return { result:'基準未到達', note:`基準未到達（実効湿度${round1_(effHum)}% / 最小湿度${minHum}% / 最新10分風速${obs ?? '欠測'}m/s${fcLv ? ' / 予報'+fcLv+'m級' : ''}）` };
  const excludeRain  = rainToday != null && rainToday > 0;
  const excludeHumid = effHum >= 70 && minHum >= 50;
  const kijun2Valid  = kijun2 && !(excludeRain || excludeHumid);
  if (!(kijun1 || kijun2Valid)) {
    const reasons = [];
    if (excludeRain)  reasons.push(`降雨・降雪あり（当日降水${rainToday}mm）`);
    if (excludeHumid) reasons.push('実効湿度70%以上かつ最小湿度50%以上');
    return { result:'基準未到達', note:`基準②該当だが除外条件に該当（${reasons.join('、')}）` };
  }
  const reasons = [];
  if (kijun1)      reasons.push(`基準①：実効湿度${round1_(effHum)}%≤60／最小湿度${minHum}%≤40／風速≥10`);
  if (kijun2Valid) reasons.push(`基準②：風速≥12`);
  return { result:'基準到達', note:reasons.join(' ／ ') };
}

function calcStreak_(history, threshold) {
  let c = 0;
  (history || []).forEach(h => { if (c === -1) return; if (h.wind != null && h.wind >= threshold) c++; else c = -1; });
  return c === -1 ? Math.max(0, (history || []).findIndex(h => !(h.wind != null && h.wind >= threshold))) : c;
}

// ============================================================
// ユーティリティ
// ============================================================
function getLast30Dates_() {
  const arr = [];
  for (let i=29; i>=0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i - 1);
    arr.push({ y:d.getFullYear(), m:d.getMonth()+1, day:d.getDate(), dateStr:toDateStr_(d) });
  }
  return arr;
}

function toDateStr_(d)   { return fmt_(d, 'yyyy/MM/dd'); }
function fmt_(d, pattern){ return Utilities.formatDate(d, CONFIG.TZ, pattern); }
function round1_(n)      { return n == null || n === '' || isNaN(n) ? null : Math.round(Number(n)*10)/10; }
function nullable_(v)    { return v == null || v === '' || isNaN(v) ? null : v; }
function maxNullable_(a,b){ if (a == null) return b ?? null; if (b == null) return a; return Math.max(a,b); }
function stripHtml_(s)   { return String(s).replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&minus;/g,'-').replace(/\s+/g,' ').trim(); }
function numOrNull_(s)   { const t = String(s).replace(/[^0-9.\-]/g,''); if (!t||t==='.'||t==='-') return null; const v = parseFloat(t); return isNaN(v)?null:v; }
function json_(obj)      { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
