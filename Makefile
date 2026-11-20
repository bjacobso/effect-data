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
BENCH_MODE ?= pass6
BENCH_NODE_FLAGS ?=
bench:
	BENCH_MODE=$(BENCH_MODE) node --max-old-space-size=8192 $(BENCH_NODE_FLAGS) $(if $(filter pass7,$(BENCH_MODE)),bench/pass7.ts,bench/run.ts)
