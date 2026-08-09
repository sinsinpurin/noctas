"use client";

import { Box, Grid, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/ui/AppHeader";
import { CyberPanel } from "@/components/ui/CyberPanel";
import {
  CATEGORY_COLOR,
  NODE_CATALOG,
  PORT_COLOR,
  type NodeDef,
} from "@/components/strategy/nodeCatalog";

/**
 * 機能ドキュメント。ノードリファレンスは実際のnodeCatalogから動的生成するため、
 * ノード追加時もこのページは自動で追従する。
 */

// ---------------------------------------------------------------------------
// 小さなドキュメント用パーツ
// ---------------------------------------------------------------------------

function P({ children }: { children: ReactNode }) {
  return (
    <Text fontSize="13px" color="text.primary" lineHeight="1.9">
      {children}
    </Text>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <Text fontSize="12px" color="text.secondary" lineHeight="1.8">
      {children}
    </Text>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <Box
      as="span"
      fontFamily="mono"
      fontSize="0.92em"
      color="signal.cyan"
      bg="bg.surfaceRaised"
      px={1.5}
      py={0.5}
    >
      {children}
    </Box>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return (
    <Text
      fontFamily="heading"
      fontSize="12px"
      fontWeight="700"
      letterSpacing="0.14em"
      textTransform="uppercase"
      color="signal.cyan"
      mt={2}
    >
      <Box as="span" color="signal.red" mr={2}>
        {"›"}
      </Box>
      {children}
    </Text>
  );
}

/** 注意・補足ボックス */
function Note({ tone = "cyan", children }: { tone?: "cyan" | "orange" | "red"; children: ReactNode }) {
  const color = tone === "red" ? "#FF003C" : tone === "orange" ? "#FF8A1E" : "#00E5FF";
  return (
    <Box borderLeftWidth="3px" borderLeftColor={color} bg="bg.surfaceRaised" px={3} py={2}>
      <Text fontSize="12px" color="text.secondary" lineHeight="1.8">
        {children}
      </Text>
    </Box>
  );
}

/** 手順リスト */
function Steps({ items }: { items: ReactNode[] }) {
  return (
    <Stack gap={1.5}>
      {items.map((item, i) => (
        <HStack key={i} align="flex-start" gap={3}>
          <Text fontFamily="mono" fontSize="11px" color="signal.red" flexShrink={0} mt="2px">
            {String(i + 1).padStart(2, "0")}
          </Text>
          <Text fontSize="13px" color="text.primary" lineHeight="1.7">
            {item}
          </Text>
        </HStack>
      ))}
    </Stack>
  );
}

/** 2列の定義テーブル */
function DefTable({ rows }: { rows: { term: ReactNode; def: ReactNode }[] }) {
  return (
    <Stack gap={0}>
      {rows.map((row, i) => (
        <Grid
          key={i}
          templateColumns={{ base: "1fr", md: "220px 1fr" }}
          gap={{ base: 1, md: 4 }}
          px={3}
          py={2}
          bg={i % 2 === 0 ? "bg.surfaceRaised" : "transparent"}
        >
          <Text fontFamily="mono" fontSize="12px" color="signal.cyan">
            {row.term}
          </Text>
          <Text fontSize="12px" color="text.secondary" lineHeight="1.7">
            {row.def}
          </Text>
        </Grid>
      ))}
    </Stack>
  );
}

/** 戦略グラフの流れを示すミニ図解 */
function FlowDiagram() {
  const nodes = [
    { label: "Price", sub: "終値(1分足)", color: CATEGORY_COLOR.source },
    { label: "SMA (20)", sub: "インジケーター", color: CATEGORY_COLOR.indicator },
    { label: "Cross ↑", sub: "条件(上抜け)", color: CATEGORY_COLOR.condition },
    { label: "Buy", sub: "アクション", color: CATEGORY_COLOR.action },
  ];
  return (
    <HStack gap={0} flexWrap="wrap" rowGap={3}>
      {nodes.map((node, i) => (
        <HStack key={node.label} gap={0}>
          <Box
            borderWidth="1px"
            borderColor={node.color}
            bg="bg.surfaceRaised"
            px={4}
            py={2}
            position="relative"
          >
            <Box position="absolute" top="-1px" left="-1px" width="8px" height="8px" borderTop={`2px solid ${node.color}`} borderLeft={`2px solid ${node.color}`} />
            <Text fontFamily="heading" fontSize="11px" fontWeight="700" letterSpacing="0.1em" color={node.color}>
              {node.label}
            </Text>
            <Text fontFamily="mono" fontSize="9px" color="text.disabled">
              {node.sub}
            </Text>
          </Box>
          {i < nodes.length - 1 && (
            <Text fontFamily="mono" color="text.disabled" px={2}>
              ──▶
            </Text>
          )}
        </HStack>
      ))}
    </HStack>
  );
}

/** ノードリファレンス(nodeCatalogから動的生成) */
function NodeReference() {
  const portList = (ports: NodeDef["inputs"]) =>
    ports.length === 0
      ? "─"
      : ports.map((p) => `${p.id}(${p.kind === "number" ? "数値" : "条件"})`).join(", ");

  return (
    <Stack gap={2}>
      <HStack gap={4} mb={1}>
        <HStack gap={1.5}>
          <Box width="8px" height="8px" bg={PORT_COLOR.number} />
          <Text fontFamily="mono" fontSize="10px" color="text.secondary">数値シリーズ</Text>
        </HStack>
        <HStack gap={1.5}>
          <Box width="8px" height="8px" bg={PORT_COLOR.bool} />
          <Text fontFamily="mono" fontSize="10px" color="text.secondary">条件(真偽)シリーズ</Text>
        </HStack>
        <Text fontFamily="mono" fontSize="10px" color="text.disabled">
          ※同じ色のポート同士のみ接続できます
        </Text>
      </HStack>
      {NODE_CATALOG.map((def) => (
        <Grid
          key={def.type}
          templateColumns={{ base: "1fr", md: "110px 1fr 220px" }}
          gap={{ base: 1, md: 4 }}
          px={3}
          py={2}
          bg="bg.surfaceRaised"
          borderLeftWidth="3px"
          borderLeftColor={def.type === "sell" ? "#FF003C" : CATEGORY_COLOR[def.category]}
        >
          <Text fontFamily="heading" fontSize="12px" fontWeight="700" letterSpacing="0.08em" color="text.primary">
            {def.label}
          </Text>
          <Text fontSize="12px" color="text.secondary" lineHeight="1.6">
            {def.description}
            {def.paramFields.length > 0 && (
              <Box as="span" color="text.disabled">
                {" "}
                / 設定: {def.paramFields.map((f) => f.label).join("・")}
              </Box>
            )}
          </Text>
          <Text fontFamily="mono" fontSize="10px" color="text.disabled">
            IN: {portList(def.inputs)} → OUT: {portList(def.outputs)}
          </Text>
        </Grid>
      ))}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// ページ本体
// ---------------------------------------------------------------------------

const TOC = [
  { id: "overview", label: "概要・はじめかた" },
  { id: "dashboard", label: "Dashboard(ダッシュボード)" },
  { id: "chart", label: "Price Chart(チャート)" },
  { id: "strategies", label: "Bot Blueprint(戦略エディタ)" },
  { id: "risk", label: "リスク管理・サーキットブレーカー" },
  { id: "pnl", label: "P&L Report(損益)" },
  { id: "settings", label: "Settings(設定・AIコスト)" },
  { id: "env", label: "環境変数リファレンス" },
];

export default function DocsPage() {
  return (
    <Box minH="100vh">
      <AppHeader />

      <Box px={{ base: 4, md: 10 }} py={8} maxW="1100px" mx="auto">
        <Stack gap={6}>
          <CyberPanel title="Documentation" code="00 / INDEX" accent="red" delay={0}>
            <Stack gap={3}>
              <P>
                Noctas は、bitbankの公開データを使った
                <Box as="span" color="signal.yellow" fontWeight="700">ペーパートレード(仮想売買)</Box>
                システムです。実際の注文は一切行いません。仮想残高¥1,000,000からスタートし、
                「AIによる売買判断」と「自作Bot戦略の自動実行」の2系統で取引をシミュレートします。
              </P>
              <HStack gap={2} flexWrap="wrap">
                {TOC.map((item) => (
                  <chakra.a
                    key={item.id}
                    href={`#${item.id}`}
                    borderWidth="1px"
                    borderColor="border.gridCyan"
                    px={3}
                    py={1.5}
                    fontFamily="heading"
                    fontSize="10px"
                    fontWeight="600"
                    letterSpacing="0.1em"
                    color="signal.cyan"
                    _hover={{ boxShadow: "glowCyanSm" }}
                  >
                    {item.label}
                  </chakra.a>
                ))}
              </HStack>
            </Stack>
          </CyberPanel>

          {/* ---------------- 概要 ---------------- */}
          <Box id="overview">
            <CyberPanel title="概要・はじめかた" code="01 / START" accent="cyan" delay={0.05}>
              <Stack gap={4}>
                <SubHeading>起動</SubHeading>
                <Steps
                  items={[
                    <>ターミナル1: <Mono>npm run dev:server</Mono>(APIサーバー、port 4000)</>,
                    <>ターミナル2: <Mono>npm run dev:web</Mono>(この画面、port 3000)</>,
                    <>初回はSettings画面の「Anthropic API Key」でAPIキーを設定(AI機能に必要。<Mono>apps/server/.env</Mono> の <Mono>ANTHROPIC_API_KEY</Mono> でも可)</>,
                  ]}
                />
                <SubHeading>デスクトップ版(Windows)</SubHeading>
                <P>
                  インストーラー版はサーバーを内蔵しているため、ターミナルもブラウザも不要です。
                  設定とデータは、アップデートで入れ替わらないユーザーフォルダに保存されます。
                </P>
                <DefTable
                  rows={[
                    {
                      term: "APIキーの設定",
                      def: (
                        <>
                          Settings画面の「Anthropic API Key」から設定できます。保存すると即座に反映されるため、再起動は不要です。
                          キーはこの端末のローカルDBに保存され、画面には末尾4文字のみ表示されます。
                          上級者・開発者向けの代替手段として <Mono>%APPDATA%\Noctas\.env</Mono> の
                          <Mono>ANTHROPIC_API_KEY=</Mono> も引き続き使えます(この場合は編集後に再起動が必要)。
                          画面で保存したキーがある場合は、そちらが優先されます。
                        </>
                      ),
                    },
                    {
                      term: "データの保存先",
                      def: (
                        <>
                          <Mono>%APPDATA%\Noctas\noctas.db</Mono>(仮想残高・ポジション・約定履歴・戦略)。
                          アップデート時にスキーマ変更があれば起動時に自動で適用されるため、履歴は引き継がれます。
                          <Mono>DATABASE_URL</Mono> を .env に書いても無視されます。
                        </>
                      ),
                    },
                    {
                      term: "アップデート",
                      def: "新しいバージョンがあると自動でダウンロードし、再起動するかどうかをダイアログで尋ねます。勝手に再起動することはないので、建玉を持ったまま更新が適用されることはありません。",
                    },
                  ]}
                />
                <SubHeading>2つの取引系統</SubHeading>
                <DefTable
                  rows={[
                    {
                      term: "AI売買判断ループ",
                      def: "Claudeが相場スナップショットを定期分析してbuy/sell/holdを判断します。メインペア(TARGET_PAIRSの先頭)のみが対象で、トークン費用がかかるためSettingsでON/OFFできます。",
                    },
                    {
                      term: "Bot戦略",
                      def: "ノードエディタで組んだ戦略グラフを、戦略ごとに設定した時間足で常時評価し、条件成立の瞬間に自動発注します。Claudeを呼ばないため費用ゼロで、複数ペア・複数戦略を同時稼働できます。",
                    },
                  ]}
                />
                <Note>
                  どちらの系統も、損切り・利確・サーキットブレーカーなどのリスク管理(後述)が共通で適用されます。
                </Note>
              </Stack>
            </CyberPanel>
          </Box>

          {/* ---------------- Dashboard ---------------- */}
          <Box id="dashboard">
            <CyberPanel title="Dashboard(ダッシュボード)" code="02 / VIEW" accent="cyan" delay={0.05}>
              <Stack gap={4}>
                <P>
                  AIボット(AI売買判断・Bot戦略)の損益と保有状況を一望するページです。上部の
                  <Box as="span" color="signal.cyan">ペアタブ</Box>
                  (BTC/JPY・ETH/JPYなど、ペアが2つ以上のとき表示)で表示対象を切り替えられます。
                  相場チャートは<Box as="span" color="signal.cyan">Price Chart</Box>タブに分離されています。
                </P>
                <DefTable
                  rows={[
                    { term: "Positions / P&L", def: "選択ペアの保有中ポジションと含み損益(緑=利益/赤=損失)。各ポジションの「決済」ボタンから、AI判断・Bot戦略・自動損切りを待たずに現在値で成行の手動決済ができます(確認ダイアログあり)。決済理由は「手動決済」として記録され、Trade History・P&L Reportにも反映されます。" },
                    { term: "System Status", def: "配信接続状態と、本日のAIトークン使用量・日次予算の消化状況。" },
                    { term: "Trade History", def: "全ペアの約定履歴。発生理由(AI判断/BOT戦略/損切り/利確/トレーリング)のラベル付き。" },
                  ]}
                />
              </Stack>
            </CyberPanel>
          </Box>

          {/* ---------------- Price Chart ---------------- */}
          <Box id="chart">
            <CyberPanel title="Price Chart(チャート)" code="02b / MARKET" accent="cyan" delay={0.05}>
              <Stack gap={4}>
                <P>
                  相場チャートと、価格・指標ベースの監視盤をまとめたページです。ホイールでのズーム/パン操作は
                  ペアや時間足を切り替えるまで保持されます(価格更新のたびにリセットされることはありません)。
                </P>
                <DefTable
                  rows={[
                    { term: "Price Chart", def: "選択ペア・時間足のローソク足と、その下段に出来高バー(緑=陽線/赤=陰線)を表示。サーバー起動時にbitbankから直近3日分(CANDLE_SEED_DAYSで変更可)のOHLCV履歴を自動取得するため、起動直後からチャート・指標・戦略評価がフルで使えます。以降はWebSocketでリアルタイム更新。出来高はbitbankティッカーの24時間累計値の差分から推定しているため、参考値です。TFセレクタで1分〜1日足に切替可能(出来高も切替先の足の合計に集計し直されます)。" },
                    { term: "チャートマーカー", def: "ローソク足上に約定(▲買い/▼売り)と見送りシグナル(●)を表示。チャート上部のMARKERSトグルでON/OFFできます。" },
                    { term: "建値ライン", def: "選択ペアに保有中のポジションがあれば、その建値に黄色の破線を自動表示します(Dashboardの手動決済ボタンで決済すると消えます)。" },
                    { term: "Signal Monitor", def: "「RSI(14) < 30」「価格がSMA(20)を上抜け」のような監視条件を自由に追加・編集・削除できる監視盤。現在値と成立◯/✕が10秒ごとに更新されます(発注はしません)。左辺=価格/指標、右辺=固定値/指標、演算子は大小比較とクロスから選択。" },
                    { term: "Bot Signal Feed", def: "Bot戦略の発火履歴(約定・見送り)。ペア・約定有無・戦略でフィルタできます。履歴はDBに保存されるためリロード後も残ります。" },
                  ]}
                />
              </Stack>
            </CyberPanel>
          </Box>

          {/* ---------------- Strategies ---------------- */}
          <Box id="strategies">
            <CyberPanel title="Bot Blueprint(戦略エディタ)" code="03 / BOT" accent="cyan" delay={0.05}>
              <Stack gap={4}>
                <P>
                  ブループリント型のノードエディタで売買ルールを組み立てるページです。
                  ノードを線でつなぐだけで「SMAゴールデンクロスで買う」のような戦略が作れます。
                </P>

                <SubHeading>戦略グラフの基本形</SubHeading>
                <FlowDiagram />
                <Muted>
                  データ源(Price/Constant)→ インジケーター(SMA/EMA/RSI)→ 条件(Compare/Cross)→
                  アクション(Buy/Sell)の順につなぎます。条件が「不成立→成立」に変わった瞬間だけ発火し、
                  発火後60秒はクールダウンで再発火しません。
                </Muted>

                <SubHeading>使い方</SubHeading>
                <Steps
                  items={[
                    "左のNode Paletteからクリックまたはドラッグ&ドロップでノードを配置",
                    "ポート(◈)同士をドラッグで接続(同じ色のポートのみ接続可能)/ Backspaceで選択要素を削除",
                    <>戦略名・ペア・評価する時間足(セレクタ)を設定し、必要ならリスク設定(後述)を入力して <Mono>Save</Mono></>,
                    <>保存済み一覧(Deployed Strategies)で <Mono>Deploy</Mono> を押すと稼働開始。<Mono>Stop</Mono> で停止</>,
                  ]}
                />
                <Note>
                  キャンバス上の各ノードには、サーバーが実際に見ているのと同じ選択中の時間足のデータでの
                  現在値・条件の◯/✕がライブ表示されます(10秒ごと更新)。Deployする前に
                  「いま条件がどう評価されているか」を確認できます。
                </Note>

                <SubHeading>AI Strategy Gen(AI自動生成)</SubHeading>
                <P>
                  右カラムの「AI Strategy Gen」に日本語で要望を書くと(例:
                  「RSIが30を下回ったら買い、70を超えたら売り」)、Claudeが戦略グラフを設計して
                  キャンバスに展開します。生成物はサーバー側で接続・型・実行時エラーを検証済みですが、
                  <Box as="span" color="signal.yellow">保存はされません</Box>
                  — 内容を確認・調整してからSaveしてください。生成1回あたり数円のAPIコストがかかります。
                </P>
                <P>
                  P&L Reportの「AI Review」でレビューを取得した後、その画面の
                  「この内容でAI戦略を生成する(Bot Blueprintへ)」ボタンを押すとこのページへ移動し、
                  レビューの懸念点・改善提案を踏まえた要望で戦略を生成できます。参照中のレビュー本文は
                  AI Strategy Gen欄の上に表示され、「参照を外す」でレビュー抜きの通常の生成に戻せます。
                </P>
                <Note>
                  戦略名の隣にある時間足セレクタで選んだ値は、AI Strategy Genの生成リクエスト
                  (「1分足で動くBot」のような前提としてClaudeへ渡る)と、Save/Update後の戦略の
                  時間足設定の両方に使われます。保存された時間足はライブ稼働時にもそのまま使われ、
                  Bot戦略はエディタで確認したのと同じ時間足で評価されます。生成完了後にキャンバスへ
                  内容を反映するかどうかの確認は、ブラウザのネイティブダイアログではなく画面内の
                  確認ダイアログで行います(テンプレート読み込み・戦略の削除も同様)。
                </Note>

                <SubHeading>AI Judgment(AI判断ノード)</SubHeading>
                <P>
                  Claudeによる売買判断を、他の技術的条件と同じように条件ノードとして組み込めます。
                  「判断」でBUY/SELLどちらに反応するか、「最小確信度」でしきい値を選べます。
                  判断は数分間隔でキャッシュされ(Settingsの日次予算・ON/OFFの対象)、新しい判断が
                  届いた瞬間だけ立ち上がりエッジとして発火します。Claudeへのプロンプトには現在値・
                  出来高に加えてRSI(14)・移動平均(20)からの乖離率・ボラティリティ(20)、および
                  対象ペアの保有ポジション件数・含み損益・サーキットブレーカーの発動状態も
                  文脈として渡され、判断の整合性を高めています。
                </P>
                <Note tone="orange">
                  Claude APIを呼び出すためコストが発生し、頻度も数分に1回程度に制限されます。
                  ai_judgment単体をBuy/Sellへ直結するより、SMA/RSIなどの技術的条件とANDで
                  組み合わせる使い方を推奨します。Deploy前のライブプレビューでは、そのペアを
                  使う戦略をDeployするまでAI判断が「未取得」のままになります。
                </Note>

                <SubHeading>Backtest(保存前のバックテスト)</SubHeading>
                <P>
                  エディタ中央カラムの「Backtest」パネルで <Mono>Run Backtest</Mono> を押すと、
                  キャンバス上のグラフ(<Box as="span" color="signal.yellow">保存前でも実行できます</Box>)を、
                  サーバーが既に保持している過去のローソク足履歴(起動時にシードした
                  最大 <Mono>CANDLE_SEED_DAYS</Mono> 日分、既定3日)に対して1本ずつウォークフォワードで
                  再生します。手数料(<Mono>TRADE_FEE_PCT</Mono>)・スリッページ(<Mono>TRADE_SLIPPAGE_PCT</Mono>)、
                  および設定中の損切り/利確/トレーリングストップを実際のペーパートレードと同じ計算式で
                  適用したうえで、仮想の損益カーブと勝率・プロフィットファクター・最大ドローダウンなどの
                  統計を返します。結果はその場限りの計算で、DBには一切保存されません
                  (実際のポジション・AI判断ループへの書き込みも発生しません)。
                </P>
                <P>
                  統計タイルの「値幅合計(手数料前)」は各トレードの手数料控除前の損益(<Mono>grossPnlJpy</Mono>)
                  の合計、「手数料負け」はそのうち値動きの方向自体は建玉に有利だったのに、手数料込みの
                  純損益が0以下になってしまったトレードの件数(<Mono>feeLossCount</Mono>)です。
                  この件数が多い、または「値幅合計(手数料前)」が0円付近なのに純損益(Realized P&L)が
                  大きくマイナスな場合は、戦略自体の方向判定精度ではなく、手数料に対して利益幅が
                  小さすぎること(オーバートレード気味であること)が主な敗因である可能性を示します。
                </P>
                <Note tone="orange">
                  近似・簡略化している点: (1) <Mono>ai_judgment</Mono>ノードは過去のAI判断ログを
                  保持していないため再現できず、バックテスト中は常に不成立(発火しない)として扱われます
                  (グラフに含まれる場合は結果画面に警告が表示されます)。(2)
                  損切り/利確/トレーリングストップの判定はローソク足の高値・安値も使いますが、
                  同一足の中で両方の条件を満たした場合は「安値側(損切り/トレーリング)が先に発生した」と
                  保守的な順序を仮定します。(3) サーキットブレーカー(日次損失・連敗による自動停止)は
                  シミュレートしません。これらの理由から、Deploy後の実際の結果と完全には一致しません。
                </Note>
                <Note tone="orange">
                  3ヶ月シミュレーション(period: three_months)は、対象の時間足で90日分を評価すると
                  ローソク足が多すぎる場合(目安として1分足)、計算量(バックテストエンジンの特性上
                  O(n²))的にサーバー全体を長時間ブロックしてしまうため、実行前に400エラーで拒否されます。
                  この場合は5分足以上の粗い時間足を選択してください。
                </Note>

                <SubHeading>Walk-Forward Validation(アクティブ戦略の過学習チェック)</SubHeading>
                <P>
                  Bot Blueprintエディタの「Backtest」パネル下部にある「Walk-Forward Validation」
                  セクションで <Mono>Run Walk-Forward Validation</Mono> を押すと、
                  <Box as="span" color="signal.yellow">現在アクティブな全戦略</Box>
                  の損切り/利確/トレーリングストップを、ローリング90日スナップショット
                  (「3ヶ月シミュレーション」と同じDB上のデータ)に対して複数のウィンドウへ分割し、
                  過学習していないかを検証します。各ウィンドウは
                  in-sample(直近側でSL/TP/トレーリングの組み合わせをグリッドサーチして最良のものを選ぶ区間)と、
                  それに続く out-of-sample(選んだパラメータをそのまま未見のデータで再生する区間)の
                  組で構成され、非重複のout-of-sample区間で時系列を前方へタイル状に敷き詰めます。
                </P>
                <P>
                  各戦略のカードには「現在の設定」の隣に
                  <Box as="span" color="signal.yellow">推奨値</Box>
                  が表示されます。これは全ウィンドウの<Mono>bestParams</Mono>(各in-sampleでグリッドサーチが
                  選んだSL/TP/トレーリングの組み合わせ)のうち、最も多くのウィンドウで選ばれた組み合わせ
                  (最頻値)です。複数の組み合わせが同数タイの場合は、out-of-sample の realized P&L 合計が
                  最大のものを採用します。推奨値が現在の設定と異なる場合、
                  <Mono>推奨値を適用</Mono>ボタンから確認ダイアログを経てその戦略の保存済みリスク設定
                  (損切り%・利確%・トレーリング%)を即座に上書きできます。対象戦略が稼働中(Active)の場合、
                  次のtickから新しい設定で取引されます — ただし
                  <Box as="span" color="signal.yellow">
                    すでにオープン中のポジションの損切り/利確/トレーリング設定(建玉時点のスナップショット)は変更されません
                  </Box>
                  (影響するのは今後新しく建てるポジションのみです)。適用しない場合、数値はあくまで参考情報です。
                </P>
                <P>
                  グリッドサーチの探索対象は損切り%・利確%・トレーリング%の組み合わせのみで、
                  投入額・最大ポジション数・戦略グラフ自体のノードパラメータ(SMA/RSIの期間等)は
                  対象外です。集計タイルの「Consistency」は out-of-sample の損益が0以上だった
                  ウィンドウの割合、「OOS Profit Factor」等は全ウィンドウの out-of-sample トレードを
                  合算して算出しています。
                </P>
                <Note tone="orange">
                  バックテストと同じくrunBacktest自体は足数に対してO(n²)の計算量になるため、
                  1ウィンドウあたりの足数には上限があります。既定の時間足(1分足)ではこの上限により
                  ウィンドウが意図した日数(in-sample約25日・out-of-sample約8日)より短くなり、
                  実際には数日分程度しかカバーしないことがあります。その場合は結果に警告として表示されます。
                  また、1回のリクエストでアクティブな全戦略をまとめて検証するため、戦略数が多いほど
                  1戦略あたりのウィンドウ上限が自動的に縮小されます。
                </Note>

                <SubHeading>ノードリファレンス</SubHeading>
                <NodeReference />
              </Stack>
            </CyberPanel>
          </Box>

          {/* ---------------- リスク管理 ---------------- */}
          <Box id="risk">
            <CyberPanel title="リスク管理・サーキットブレーカー" code="04 / SAFE" accent="red" delay={0.05}>
              <Stack gap={4}>
                <SubHeading>戦略ごとのリスク設定(エディタのRisk Settings)</SubHeading>
                <DefTable
                  rows={[
                    { term: "投入額 (円/回)", def: "この戦略が1回の買いで使う金額。空欄なら既定¥30,000。" },
                    { term: "最大ポジション数", def: "この戦略が同時に持てる未決済ポジション数。空欄なら既定3(ペア全体で共有)。" },
                    { term: "損切り %", def: "建値からこの%下落したら自動決済。空欄なら既定3%。" },
                    { term: "利確 %", def: "建値からこの%上昇したら自動決済。空欄なら既定5%(AI_TAKE_PROFIT_PCT)。0を入力すると利確なし(トレーリング/損切りと売り条件だけで手仕舞い)。" },
                    { term: "トレーリング %", def: "建玉後の最高値からこの%下落したら自動決済。利益を伸ばしつつ確定させたい戦略向け。空欄なら無効。" },
                  ]}
                />
                <Note tone="orange">
                  出口条件(損切り/利確/トレーリング)は建玉した瞬間の設定がポジションに記録されます。
                  後から戦略設定を変えても、すでに持っているポジションには影響しません。
                  判定の優先順は 利確 → トレーリング → 損切り です。
                </Note>

                <SubHeading>サーキットブレーカー(Settingsで設定)</SubHeading>
                <P>
                  相場急変や暴走した戦略から仮想資産を守る安全装置です。2段構えになっています:
                </P>
                <DefTable
                  rows={[
                    {
                      term: "日次最大損失",
                      def: "本日(JST)の実現損失が設定額(既定¥50,000)を超えると、AI判断・全Bot戦略の新規買いを停止します。決済・損切り・利確は動き続けます。日付が変わると自動解除、Settingsから手動解除も可能。",
                    },
                    {
                      term: "連敗自動停止",
                      def: "ある戦略が設定回数(既定5回)連続で負けると、その戦略だけ自動でStandbyになります。P&Lの戦略別成績で気づけます。",
                    },
                  ]}
                />
                <Note tone="red">
                  発動中はSettingsの安全装置パネルに赤い警告が表示されます。発動状態はサーバーを
                  再起動しても当日中は維持されます。
                </Note>

                <SubHeading>ペーパートレードのリセット(Settings)</SubHeading>
                <P>
                  約定履歴・保有ポジション・仮想残高・Botシグナル履歴を全て削除し、初期残高(¥1,000,000)
                  から再開できます。戦略の定義・AI利用ログ(トークン使用量・コスト)・各種設定は削除されません。
                  誤操作防止のため確認欄に「RESET」と入力する必要があり、取引モードが実運用(live)の場合は
                  実行できません(現状はpaperのみ対応)。
                </P>
              </Stack>
            </CyberPanel>
          </Box>

          {/* ---------------- P&L ---------------- */}
          <Box id="pnl">
            <CyberPanel title="P&L Report(損益)" code="05 / PNL" accent="cyan" delay={0.05}>
              <Stack gap={4}>
                <P>取引成績を分析するページです。全ペア・全系統の損益を合算して表示します。</P>
                <DefTable
                  rows={[
                    { term: "総損益", def: "実現損益(決済済み)+含み損益(保有中をペア別の現在値で評価)。実現損益は手数料(taker 0.12%相当)とスリッページを控除したネット値で、実運用に近い数字になっています。含み損益は手数料控除前。" },
                    { term: "勝率", def: "決済済みポジションのうち利益で終えた割合。" },
                    { term: "Profit Factor", def: "総利益÷総損失。1.0超なら通算プラス。1.5以上が一つの目安。" },
                    { term: "最大DD", def: "最大ドローダウン。累積損益カーブの山から谷への最大下落幅。リスクの大きさを示します。" },
                    { term: "Equity Curve", def: "累積実現損益の推移。ゼロ基準線より上(緑)が利益圏、下(赤)が損失圏。" },
                    { term: "Daily P&L", def: "JST日別の実現損益バー。" },
                    { term: "経路別内訳", def: "AI判断/BOT戦略/自動利確/トレーリング/自動損切りごとの損益と勝率。" },
                    { term: "戦略別成績", def: "どの戦略がいくら稼いだか。決済数・勝率・実現損益・稼働状態。負けている戦略を止める判断はここで。" },
                  ]}
                />
                <Note>
                  戦略別成績は戦略IDの記録を開始した2026-07-07以降の決済分から集計されます。
                  それ以前の決済は「AI判断・その他」枠に含まれます。
                </Note>

                <SubHeading>AI Review(取引レビュー)</SubHeading>
                <P>
                  「AIにレビューさせる」ボタンを押すと、このページと同じ損益サマリ(全体の勝率・
                  Profit Factor・経路別/戦略別内訳・直近の決済履歴)をClaudeに渡し、良い点・懸念点・
                  改善提案を日本語の文章で返します。特に、値動きの方向は合っていたのに手数料・
                  スリッページで赤字になっている取引がないかを重点的に見るよう指示しています。
                </P>
                <Note>
                  レビューは都度Claudeを呼び出す単発のAI操作で、結果は保存されません(再度押すと
                  作り直します)。決済済みの取引が1件も無い場合はボタンが無効になります。
                  消費トークン・推定コストはSettingsのAI Usage集計に含まれます。
                </Note>
                <P>
                  レビュー結果が表示されている間は「この内容でAI戦略を生成する(Bot Blueprintへ)」
                  ボタンが使えます。押すとBot Blueprintページへ移動し、AI Strategy Genがレビュー内容を
                  踏まえた戦略を提案できる状態になります(生成の実行自体はBot Blueprint側で行います)。
                </P>
              </Stack>
            </CyberPanel>
          </Box>

          {/* ---------------- Settings ---------------- */}
          <Box id="settings">
            <CyberPanel title="Settings(設定・AIコスト)" code="06 / CTRL" accent="cyan" delay={0.05}>
              <Stack gap={4}>
                <DefTable
                  rows={[
                    {
                      term: "AI Judgment",
                      def: "Bot BlueprintのAI JudgmentノードのためのClaude定期呼び出しのON/OFF。OFFにするとAI Judgmentノードは常に不成立(false)扱いになりトークン消費も止まります(Bot戦略の技術的条件・自動損切り等は動き続けます)。設定は保存され、再起動後も維持されます。日次予算(既定¥100)を超えた日は自動でスキップされます。",
                    },
                    {
                      term: "Circuit Breaker",
                      def: "安全装置の有効/無効と、日次最大損失・連敗数のしきい値設定。発動中はここに警告と手動解除ボタンが出ます。",
                    },
                    {
                      term: "AI Usage",
                      def: "AIトークン使用量と推定コスト(円)のサマリと日別テーブル。売買判断(Haiku)と戦略生成(Opus)を合算し、それぞれのモデル単価で計算します。",
                    },
                  ]}
                />
              </Stack>
            </CyberPanel>
          </Box>

          {/* ---------------- 環境変数 ---------------- */}
          <Box id="env">
            <CyberPanel title="環境変数リファレンス" code="07 / ENV" accent="cyan" delay={0.05}>
              <Stack gap={3}>
                <Muted>
                  <Mono>apps/server/.env</Mono> で設定します。変更後はサーバーの再起動が必要です。
                </Muted>
                <DefTable
                  rows={[
                    { term: "TARGET_PAIRS", def: "取引対象ペア(カンマ区切り)。例: btc_jpy,eth_jpy。先頭がメインペア。既定: btc_jpy" },
                    { term: "TRADING_MODE", def: "取引モード。現状は paper のみ対応(実運用注文APIは呼び出さない)。Settingsのペーパートレードリセットは paper のときのみ実行できる。既定: paper" },
                    { term: "ANTHROPIC_API_KEY", def: "Claude APIキー。AI売買判断・AI戦略生成・AIレビューに必要。Settings画面から設定した場合はそちらが優先され、この環境変数はフォールバックとして使われる。" },
                    { term: "AI_MODEL", def: "売買判断用モデル。既定: claude-haiku-4-5(高頻度呼び出しのため低コストモデル)" },
                    { term: "AI_STRATEGY_MODEL", def: "戦略生成用モデル。既定: claude-opus-4-8(単発・高品質重視)" },
                    { term: "AI_DAILY_BUDGET_JPY", def: "AI判断(AI Judgmentノード)の日次コスト上限(円)。超過した日は呼び出し停止。既定: 100" },
                    { term: "AI_MAX_POSITION_JPY", def: "1回の買い投入額の既定値(円)。戦略別設定が優先。既定: 30000" },
                    { term: "AI_MAX_OPEN_POSITIONS", def: "同時保有ポジション数の既定上限。既定: 3" },
                    { term: "AI_STOP_LOSS_PCT", def: "自動損切り率の既定値(%)。戦略別設定が優先。既定: 3" },
                    { term: "AI_TAKE_PROFIT_PCT", def: "自動利確率の既定値(%)。戦略別設定が優先(戦略側で0を指定した場合は利確なし)。0以外で往復コスト(TRADE_FEE_PCT+TRADE_SLIPPAGE_PCT の2回分)を下回る値は往復コストまで切り上げられる。既定: 5" },
                    { term: "BOT_COOLDOWN_MS", def: "同一戦略の連続発火を防ぐ最短間隔(ms)。既定: 60000" },
                    { term: "CANDLE_SEED_DAYS", def: "起動時にbitbankから取得する1分足の日数(1〜7)。既定: 3" },
                    { term: "TRADE_FEE_PCT", def: "ペーパートレードに反映する取引手数料(%)。bitbank現物taker相当。既定: 0.12" },
                    { term: "TRADE_SLIPPAGE_PCT", def: "成行想定のスリッページ(%)。買いは高く・売りは安く約定させる。既定: 0.02" },
                  ]}
                />
              </Stack>
            </CyberPanel>
          </Box>

          <Text fontFamily="mono" fontSize="10px" color="text.disabled" textAlign="center" pb={4}>
            // このドキュメントのノードリファレンスは実装(nodeCatalog)から自動生成されています
          </Text>
        </Stack>
      </Box>
    </Box>
  );
}
