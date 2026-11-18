import { Migrator } from "effect/sql";
import facts from "../migrations/0001_facts.ts";
import edges from "../migrations/0002_edges.ts";
export const migrate = Migrator.make({})({ loader: Migrator.fromRecord({ "0001_facts": facts, "0002_edges": edges }) });
