export npm_config_cache := $(CURDIR)/.npm-cache
.PHONY: deps migrate run test fmt bench
deps:
	pnpm install --frozen-lockfile --store-dir .pnpm-store
migrate:
	pnpm migrate
run:
	pnpm start
test:
	pnpm test
fmt:
	pnpm exec prettier --write src migrations test conformance bench package.json tsconfig.json
BENCH_MODE ?= refs
bench:
	BENCH_MODE=$(BENCH_MODE) node --max-old-space-size=8192 bench/run.ts
