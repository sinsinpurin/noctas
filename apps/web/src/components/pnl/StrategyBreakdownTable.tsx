"use client";

import { Box, Grid, Text } from "@chakra-ui/react";
import type { PnlStrategyBreakdown } from "@noctas/shared";
import { formatSignedJpy, isLowWinRate, pnlColor } from "./format";

const COLUMNS = "minmax(160px, 2fr) minmax(80px, 1fr) minmax(70px, 0.8fr) minmax(70px, 0.8fr) minmax(80px, 0.9fr) minmax(110px, 1.1fr)";

function HeaderCell({ children, align = "left" }: { children: string; align?: "left" | "right" }) {
  return (
    <Text
      fontFamily="heading"
      fontSize="10px"
      fontWeight="600"
      letterSpacing="0.14em"
      textTransform="uppercase"
      color="text.disabled"
      textAlign={align}
    >
      {children}
    </Text>
  );
}

/** 戦略ごとの実現損益テーブル。どの戦略が稼いでいるかを一目で判断するためのもの */
export function StrategyBreakdownTable({ rows }: { rows: PnlStrategyBreakdown[] }) {
  if (rows.length === 0) {
    return (
      <Text fontSize="sm" color="text.disabled">
        決済済みの取引がまだありません。
      </Text>
    );
  }

  return (
    <Box overflowX="auto">
      <Box minWidth="640px">
        <Grid templateColumns={COLUMNS} gap={3} px={3} pb={2}>
          <HeaderCell>戦略</HeaderCell>
          <HeaderCell>ペア</HeaderCell>
          <HeaderCell>状態</HeaderCell>
          <HeaderCell align="right">決済数</HeaderCell>
          <HeaderCell align="right">勝率</HeaderCell>
          <HeaderCell align="right">実現損益</HeaderCell>
        </Grid>

        {rows.map((row) => {
          const winRate = row.closedCount > 0 ? (row.winCount / row.closedCount) * 100 : 0;
          const lowWinRate = isLowWinRate(row.winCount, row.closedCount);
          return (
            <Grid
              key={row.strategyId ?? "__other__"}
              templateColumns={COLUMNS}
              gap={3}
              px={3}
              py={2}
              bg="bg.surfaceRaised"
              borderBottomWidth="1px"
              borderBottomColor="bg.surface"
              alignItems="center"
            >
              <Text fontFamily="heading" fontSize="xs" fontWeight="600" color="text.primary" truncate>
                {row.strategyName}
              </Text>
              <Text fontFamily="mono" fontSize="xs" color="signal.cyan">
                {row.pair ? row.pair.toUpperCase() : "--"}
              </Text>
              <Text
                fontFamily="mono"
                fontSize="xs"
                color={
                  row.strategyId === null
                    ? "text.disabled"
                    : row.isActive
                      ? "signal.green"
                      : "signal.orange"
                }
              >
                {row.strategyId === null ? "--" : row.isActive ? "ACTIVE" : "STANDBY"}
              </Text>
              <Text fontFamily="mono" fontSize="xs" color="text.secondary" textAlign="right">
                {row.closedCount}回
              </Text>
              <Text
                fontFamily="mono"
                fontSize="xs"
                color={lowWinRate ? "signal.red" : "text.secondary"}
                fontWeight={lowWinRate ? "700" : "normal"}
                textAlign="right"
              >
                {lowWinRate ? `⚠ ${winRate.toFixed(0)}%` : `${winRate.toFixed(0)}%`}
              </Text>
              <Text fontFamily="mono" fontSize="xs" color={pnlColor(row.realizedPnl)} textAlign="right">
                {formatSignedJpy(row.realizedPnl)}
              </Text>
            </Grid>
          );
        })}
      </Box>
    </Box>
  );
}
