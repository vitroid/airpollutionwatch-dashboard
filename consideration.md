このダッシュボードに、大気成分と同じ要領で気象の情報も重ねたいと考えています。

airpollutionwatch APIにその機能をつけるのは正しくないでしょう。

openmeteoからダイレクトにデータを取得する場合、あっというまにアクセス制限に到達します。

openmeteoのAPIはデータの大きさよりもアクセス回数での制限が厳しいので、一時間に一回、openmeteoから全国の気象情報をとってくる(airpollutionwatch API)のようなバッファーレイヤを作るのが良いのではないかと思います。

見解、助言をこの下に書いて下さい。

---

## 見解・助言メモ

- **気象を airpollutionwatch API 本体に直結させるのは慎重でよい**
  - 大気成分 API に「外部サービスのプロキシ・キャッシュ機能」まで背負わせると責務が増えすぎる。
  - 気象は別レイヤ（バッファ／キャッシュ）として切り出した方が、運用・スケール・障害切り分けの面で健全。

- **「open-meteo バッファーレイヤ」を airpollutionwatch に隣接するサービスとして設計する案が妥当**
  - 1時間に1回、全国分の気象を open-meteo からまとめて取得し、自前ストレージにキャッシュする専用サービス（仮称: weather-buffer）を用意する。
  - weather-buffer が「時刻＋地点 (lon/lat or station_id) → 気象値」を返す API を持つ。
  - airpollutionwatch API 本体は大気成分の集約・加工に専念し、ダッシュボードは
    - 大気成分 → airpollutionwatch
    - 気象 → weather-buffer
    の2本立てで参照する構成が分かりやすい。

- **実装の現実的な切り方（案）**
  - バッファサービス側:
    - バッチ（cron / systemd timer / GitHub Actions など）で 1時間ごとに open-meteo を叩き、グリッド or 代表点で全国分を取得して保存（PostgreSQL / SQLite / Parquet 等）。
    - API 例: `GET /v1/weather?lon=...&lat=...&datetime=...` で最近時刻のデータを返す。
  - airpollutionwatch 側:
    - `station` メタ情報の lon/lat を利用し、必要なら内部から weather-buffer を叩いて「大気成分＋気象」をまとめたレスポンスを別エンドポイントで提供することも可能（が、必須ではない）。
  - ダッシュボード側:
    - これまで通り airpollutionwatch API から大気成分を取得。
    - 地図やテーブルを描画する際に weather-buffer から気温・湿度・風を引き、重ね書きする。

- **open-meteo の制限回避という観点からも妥当**
  - フロントエンドから直接 open-meteo を叩くと、クライアント数に比例してリクエストが増え、簡単にレートリミットに達する。
  - バッファレイヤが「1時間に1回まとめて取得 → 複数クライアントに配る」形にすることで、
    - open-meteo へのアクセス回数を O(1)/h に抑えつつ
    - クライアント側はほぼ自由に参照できる、
    という構成にできる。

---

## UI要望メモ（回帰防止）

- **地図操作とパネルドラッグの分離**
  - Leaflet 地図のドラッグ（パン）操作中に GridStack のパネルドラッグが同時に発火しないこと。
  - 地図領域（`.map-wrap` / `.leaflet-container` 等）は GridStack 側で drag cancel 対象にする。

- **成分ヒートマップ（OX）の描画範囲**
  - 県bbox固定ではなく、地図の viewarea（viewport bounds）に追従してヒートマップを描くこと。
  - パン/ズーム/リサイズでも viewarea に合わせて再取得・再描画されること。

- **AMeDASパネルは県セレクタ非連動**
  - 県変更で AMeDAS 地図の中心・ズーム・表示範囲が勝手に変わらないこと。
  - 温度ヒートマップ/風ベクトルは常に viewarea をカバーし、余白が出にくいよう取得bboxにパディングを入れること。