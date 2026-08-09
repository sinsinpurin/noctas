"use client";

import { Box, HStack, Stack, Text } from "@chakra-ui/react";
import type { PnlReasonBreakdown, TradeReason } from "@noctas/shared";
import { formatSignedJpy, isLowWinRate, pnlColor } from "./format";

const REASON_STYLE: Record<TradeReason, { label: string; color: string }> = {
  ai_decision: { label: "AI判断", color: "#FF003C" },
  bot_strategy: { label: "BOT戦略", color: "#00E5FF" },
  take_profit: { label: "自動利確", color: "#39FF88" },
  trailing_stop: { label: "トレーリング", color: "#FF8A1E" },
  stop_loss: { label: "自動損切り", color: "#FF8A1E" },
  manual: { label: "手動決済", color: "#FCEE0A" },
};

const REASON_ORDER: TradeReason[] = [
  "ai_decision",
  "bot_strategy",
  "take_profit",
  "trailing_stop",
  "stop_loss",
  "manual",
];

/** 決済理由(AI判断 / BOT戦略 / 自動損切り)ごとの実現損益内訳 */
export function ReasonBreakdownPanel({ byReason }: { byReason: PnlReasonBreakdown[] }) {
  if (byReason.length === 0) {
    return (
      <Text fontSize="sm" color="text.disabled">
        決済済みの取引がまだありません。
      </Text>
    );
  }

  const rows = REASON_ORDER.map((reason) => byReason.find((b) => b.reason === reason)).filter(
    (b): b is PnlReasonBreakdown => b !== undefined
  );

  return (
    <Stack gap={2}>
      {rows.map((row) => {
        const style = REASON_STYLE[row.reason];
        const winRate = row.count > 0 ? (row.winCount / row.count) * 100 : 0;
        const lowWinRate = isLowWinRate(row.winCount, row.count);
        return (
          <Box
            key={row.reason}
            position="relative"
            bg="bg.surfaceRaised"
            p={3}
            pl={4}
            _before={{
              content: '""',
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: "4px",
              bg: style.color,
            }}
          >
            <HStack justify="space-between">
              <Text
                fontFamily="heading"
                fontSize="11px"
                fontWeight="600"
                letterSpacing="0.14em"
                textTransform="uppercase"
                color={style.color}
              >
                {style.label}
              </Text>
              <Text fontFamily="mono" fontSize="sm" color={pnlColor(row.pnl)}>
                {formatSignedJpy(row.pnl)}
              </Text>
            </HStack>
            <HStack justify="space-between" mt={1}>
              <Text fontSize="xs" color="text.secondary" fontFamily="mono">
                決済 {row.count}回
              </Text>
              <Text
                fontSize="xs"
                color={lowWinRate ? "signal.red" : "text.secondary"}
                fontFamily="mono"
                fontWeight={lowWinRate ? "700" : "normal"}
              >
                {lowWinRate ? "⚠ " : ""}勝率 {winRate.toFixed(0)}% ({row.winCount}勝{row.count - row.winCount}敗)
              </Text>
            </HStack>
          </Box>
        );
      })}
    </Stack>
  );
}
