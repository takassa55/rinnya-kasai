# 林野火災注意報・警報 / 火災警報 判定ダッシュボード

## プロジェクト概要

気象庁の公開データを収集し、岐阜県大垣市・池田町における **林野火災注意報・警報** および **火災警報** の発令気象条件を自動判定するシステム。判定結果に変化があった際は Slack に通知する。

---

## アーキテクチャ

```
気象庁API (JMA) ──► GAS (Code.gs) ──► Google スプレッドシート
                         │                        │
                    10分ごと実行               Web API (doGet)
                    (時間ベーストリガー)              │
                                               index.html ──► ブラウザ表示
                         │
                    判定変化時
                         │
                      Slack (Incoming Webhook)
```

### 構成ファイル

| ファイル | 役割 |
|---|---|
| `Code.gs` | GAS メインスクリプト。気象データ取得・判定・スプレッドシート記録・Web API |
| `Code_Slack通知追加分.gs` | Slack 通知機能（`Code.gs` の末尾に追記して使う） |
| `index.html` | ダッシュボード HTML（GAS Web API からデータを取得して描画） |

---

## データソース（気象庁 API）

| データ | URL |
|---|---|
| 警報・注意報 JSON | `https://www.jma.go.jp/bosai/warning/data/r8/210000.json` |
| 警報タイムライン（風速予報） | `https://www.jma.go.jp/bosai/warning_timeline/data/210000.json` |
| 府県天気予報 | `https://www.jma.go.jp/bosai/forecast/data/forecast/210000.json` |
| ETRN 過去データ（日別） | `https://www.data.jma.go.jp/stats/etrn/view/daily_a1.php?prec_no=…&block_no=…` |
| アメダスリアルタイム（3時間ブロック） | `https://www.jma.go.jp/bosai/amedas/data/point/{amedas_no}/{yyyyMMdd}_{HH}.json` |

---

## 対象地点

| 市町名 | amedas_no | area_code | 観測地点名 |
|---|---|---|---|
| 大垣市 | 52581 | 2120200 | 大垣（大垣市禾森町） |
| 池田町 | 52511 | 2140400 | 揖斐川（揖斐郡揖斐川町三輪） |

- `prec_no=52`（岐阜県）
- `block_no`: 大垣=0496、池田=1301（ETRN 参照用）

---

## 判定ロジック

### 林野火災注意報・警報（`forestJudge_`）

| 判定 | 条件 |
|---|---|
| 注意報 | （前3日降水量 ≤ 1mm かつ 前30日降水量 ≤ 30mm）または（前3日 ≤ 1mm かつ 乾燥注意報発表中） |
| 警報 | 注意報条件 + 強風注意報（または暴風注意報）発表中 |
| 発令なし | 上記以外 |

- 対象期間は1〜5月（HTML 側で期間外は参考表示に切り替え）

### 火災警報（`fireWarningJudge_`）

根拠：大垣消防組合消防法等施行細則

| 基準 | 条件 |
|---|---|
| 基準① | 実効湿度 ≤ 60% **かつ** 最小湿度 ≤ 40% **かつ** 風速 ≥ 10m/s（実況または予報） |
| 基準②  | 風速 ≥ 12m/s（実況または予報） |

**除外条件（基準②のみ適用）**：以下いずれか該当で基準②は発令対象外
- 当日降水量 > 0mm（降雨・降雪あり）
- 実効湿度 ≥ 70% かつ 最小湿度 ≥ 50%

### 実効湿度（`effectiveHumidity_`）

```
He(n) = 0.3 × H(n) + 0.7 × He(n-1)
```

- 減衰定数 r = 0.7（`CONFIG.EFFECTIVE_HUMIDITY_R`）
- 前30日分の ETRN 日別平均湿度 + 当日アメダス実況を使用

---

## スプレッドシート構造

| シート名 | 内容 |
|---|---|
| `現在状況` | 最新の判定データ（実行のたびに全行上書き） |
| `履歴_YYYY_MM` | 月別ログ（観測キーが変化した行のみ追記） |
| `設定` | 対象地点の設定値 |
| `エラーログ` | GAS 実行中のエラー記録 |

**主要列（`CURRENT_HEADERS`）**: 更新日時、観測時刻、市町名、観測地点、前3日/前30日/当日降水量、平均/最小湿度、実効湿度、最大/最新10分/予報最大風速、乾燥・強風注意報フラグ、林野火災判定、火災警報判定、判定理由、10m/s・12m/s 連続回数、他（JSON 詳細列含む）

---

## GAS 主要関数

| 関数 | 役割 |
|---|---|
| `collectWeatherData()` | メイン処理。10 分ごと自動実行 |
| `doGet(e)` | Web API エンドポイント。`?action=current` でデータ返却 |
| `initializeSheets()` | 初回セットアップ（シート作成・ヘッダー設定） |
| `createTenMinuteTrigger()` | 10 分トリガーを登録 |
| `fetchLast30Daily_(station)` | 過去 30 日分の日別気象データ（ETRN） |
| `fetchAmedasToday_(amedasNo)` | 当日のアメダスリアルタイムデータ |
| `parseWarnings_(data, areaCode)` | 警報・注意報 JSON のパース |
| `parseTimelineWind_(data, areaCode)` | タイムライン風速予報のパース |
| `forestJudge_(...)` | 林野火災判定 |
| `fireWarningJudge_(...)` | 火災警報判定 |
| `effectiveHumidity_(avgHums)` | 実効湿度の計算 |

---

## Slack 通知

`Code_Slack通知追加分.gs` を `Code.gs` 末尾に追記して使用。

### セットアップ手順
1. `CONFIG` オブジェクトに `SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/...'` を追加
2. `collectWeatherData()` 内の `writeCurrent_(ss, rows);` の直後に `sendSlackIfVerdictChanged_(rows);` を追加

### 動作仕様
- 林野火災判定または火災警報判定が前回から変化した地点のみ通知
- 初回実行時は記録のみ（通知しない）
- 送信失敗時は次回実行時に再試行（前回値を更新しない）
- Block Kit 形式でメッセージを構築

### テスト用関数
- `testSlackNotify()` — テスト通知を手動送信
- `resetSlackVerdictProperties()` — 前回判定をリセット

---

## 初回デプロイ手順

1. Apps Script に `Code.gs` を貼り付け、末尾に `Code_Slack通知追加分.gs` の内容を追記
2. `CONFIG.SPREADSHEET_ID` にスプレッドシートの ID を記入（空欄の場合はスクリプトに紐付いたシートを使用）
3. `CONFIG.SLACK_WEBHOOK_URL` に Slack の Incoming Webhook URL を記入
4. `initializeSheets()` を 1 回手動実行
5. `createTenMinuteTrigger()` を 1 回手動実行
6. `collectWeatherData()` を手動実行して動作確認
7. デプロイ → 新しいデプロイ → ウェブアプリ → アクセス: **全員** で公開
8. `index.html` の `GAS_API_URL` に発行された URL を設定

---

## HTML ダッシュボード

- GAS Web API（`?action=current`）から JSON を取得して描画（JMA に直接アクセスしない）
- 2 セクション構成: **林野火災注意報・警報** / **火災警報**
- 各地点パネルに判定結果・気象値・日別降水量グラフ・注意報警報タグを表示
- 実効湿度の計算根拠、10 分風速履歴、3 時間別風速予報を折りたたみ表示
- **判定シミュレーター**: 任意の気象値を入力して基準適否をリアルタイム確認

---

## 注意事項

- 本システムの判定は **気象条件の充足を示すもの** であり、実際の発令は消防長の判断による
- アメダスデータは 10 分値を使用するため、観測から最大 20 分程度の遅延が発生する場合がある
- GAS の無料枠では 1 日の URL フェッチ回数に上限があるため、対象地点を増やす際は注意が必要
