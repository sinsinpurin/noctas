-- CreateTable
CREATE TABLE "StrategyVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "strategyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "graph" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL,
    "positionSizeJpy" REAL,
    "maxOpenPositions" INTEGER,
    "stopLossPct" REAL,
    "takeProfitPct" REAL,
    "trailingStopPct" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StrategyVersion_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "StrategyVersion_strategyId_createdAt_idx" ON "StrategyVersion"("strategyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyVersion_strategyId_version_key" ON "StrategyVersion"("strategyId", "version");
