"use client";

import { memo } from "react";
import { Box, HStack, Stack, Text } from "@chakra-ui/react";
import {
  Handle,
  Position,
  useReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { NodeLiveValue, StrategyNodeParams, StrategyNodeType } from "@noctas/shared";
import {
  NODE_DEF_BY_TYPE,
  PORT_COLOR,
  nodeAccentColor,
  type ParamField,
} from "./nodeCatalog";
import { useLiveNodeValue } from "./LiveValuesContext";

export type BlueprintNodeData = { params: StrategyNodeParams };
export type BlueprintFlowNode = Node<BlueprintNodeData>;

const handleStyle = (color: string): React.CSSProperties => ({
  width: 10,
  height: 10,
  borderRadius: 0,
  transform: "translateY(-50%) rotate(45deg)",
  background: "#131318",
  border: `2px solid ${color}`,
});

function ParamInput({
  nodeId,
  field,
  params,
}: {
  nodeId: string;
  field: ParamField;
  params: StrategyNodeParams;
}) {
  const { updateNodeData } = useReactFlow();
  const value = params[field.key];

  const inputCss = {
    background: "#0A0A0D",
    border: "1px solid rgba(0,229,255,0.22)",
    color: "#F2F2F5",
    fontFamily: "var(--font-jetbrains-mono), monospace",
    fontSize: "11px",
    padding: "3px 6px",
    width: "100%",
    outline: "none",
  } as const;

  if (field.kind === "select") {
    return (
      <select
        className="nodrag"
        style={inputCss}
        value={String(value ?? field.options[0]?.value ?? "")}
        onChange={(e) =>
          updateNodeData(nodeId, { params: { ...params, [field.key]: e.target.value } })
        }
      >
        {field.options.map((opt) => (
          <option key={opt.value} value={opt.value} style={{ background: "#1C1C24" }}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      className="nodrag"
      style={inputCss}
      type="number"
      min={field.min}
      max={field.max}
      step={field.step}
      value={typeof value === "number" ? value : Number(value ?? 0)}
      onChange={(e) =>
        updateNodeData(nodeId, { params: { ...params, [field.key]: Number(e.target.value) } })
      }
    />
  );
}

function formatLiveNumber(value: number): string {
  if (Math.abs(value) >= 1000) {
    return Math.round(value).toLocaleString("ja-JP");
  }
  return value.toFixed(2);
}

/** 現在の相場データでの評価結果バッジ。真偽は◯/✕、数値はそのまま表示する */
function LiveValueBadge({ value }: { value: NodeLiveValue | undefined }) {
  if (value === undefined) return null; // データ未取得(サーバー未接続など)

  if (typeof value === "boolean") {
    return (
      <Text
        fontFamily="mono"
        fontSize="11px"
        fontWeight="700"
        lineHeight="1"
        color={value ? "#39FF88" : "#4B4B55"}
        css={value ? { textShadow: "0 0 6px rgba(57,255,136,.6)" } : undefined}
        title={value ? "現在成立しています" : "現在は不成立です"}
      >
        {value ? "◯" : "✕"}
      </Text>
    );
  }

  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="10px" lineHeight="1" color="text.disabled" title="データ蓄積中(期間分の履歴が必要です)">
        --
      </Text>
    );
  }

  return (
    <Text fontFamily="mono" fontSize="10px" lineHeight="1" color="#00E5FF" title="現在の値">
      {formatLiveNumber(value)}
    </Text>
  );
}

function BlueprintNodeViewInner({ id, type, data, selected }: NodeProps<BlueprintFlowNode>) {
  const liveValue = useLiveNodeValue(id);
  const def = NODE_DEF_BY_TYPE.get(type as StrategyNodeType);
  if (!def) return null;

  const accent = nodeAccentColor(def.type);
  const params = data.params ?? {};

  return (
    <Box
      minW="168px"
      bg="bg.surface"
      borderWidth="1px"
      borderColor={selected ? accent : "border.gridCyan"}
      boxShadow={selected ? `0 0 6px ${accent}88, 0 0 20px ${accent}33` : "elevationPanel"}
      transition="box-shadow 120ms ease, border-color 120ms ease"
      fontFamily="body"
    >
      {/* header */}
      <HStack
        px={3}
        py={2}
        gap={2}
        borderBottomWidth="1px"
        borderBottomColor="border.gridCyan"
        bg="bg.surfaceRaised"
        justify="space-between"
      >
        <HStack gap={2}>
          <Box width="7px" height="7px" bg={accent} transform="rotate(45deg)" flexShrink={0} />
          <Text
            fontFamily="heading"
            fontWeight="600"
            fontSize="11px"
            letterSpacing="0.14em"
            textTransform="uppercase"
            color={accent}
            lineHeight="1"
          >
            {def.label}
          </Text>
        </HStack>
        <LiveValueBadge value={liveValue} />
      </HStack>

      <Stack py={2} gap={1.5}>
        {/* input ports */}
        {def.inputs.map((port) => (
          <Box key={port.id} position="relative" px={3}>
            <Handle
              type="target"
              position={Position.Left}
              id={port.id}
              style={{ ...handleStyle(PORT_COLOR[port.kind]), left: -6, top: "50%" }}
            />
            <Text fontFamily="mono" fontSize="10px" color="text.secondary" lineHeight="1.4">
              ◈ {port.label}
            </Text>
          </Box>
        ))}

        {/* params */}
        {def.paramFields.length > 0 && (
          <Stack px={3} gap={1}>
            {def.paramFields.map((field) => (
              <HStack key={field.key} gap={2}>
                <Text
                  fontFamily="mono"
                  fontSize="10px"
                  color="text.disabled"
                  flexShrink={0}
                  minW="28px"
                >
                  {field.label}
                </Text>
                <ParamInput nodeId={id} field={field} params={params} />
              </HStack>
            ))}
          </Stack>
        )}

        {/* output ports */}
        {def.outputs.map((port) => (
          <Box key={port.id} position="relative" px={3} textAlign="right">
            <Handle
              type="source"
              position={Position.Right}
              id={port.id}
              style={{ ...handleStyle(PORT_COLOR[port.kind]), right: -6, top: "50%" }}
            />
            <Text fontFamily="mono" fontSize="10px" color="text.secondary" lineHeight="1.4">
              {port.label} ◈
            </Text>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

export const BlueprintNodeView = memo(BlueprintNodeViewInner);
