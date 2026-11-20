import { Migrator } from "effect/sql";
import facts from "../migrations/0001_facts.ts";
import edges from "../migrations/0002_edges.ts";
import refs from "../migrations/0003_live_refs.ts";
import shapes from "../migrations/0004_event_shapes.ts";
import versions from "../migrations/0005_registry_versions.ts";
import rollouts from "../migrations/0006_rollouts.ts";
import targets from "../migrations/0007_stored_ref_targets.ts";
import cells from "../migrations/0008_cells.ts";
export const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_facts": facts,
    "0002_edges": edges,
    "0003_live_refs": refs,
    "0004_event_shapes": shapes,
    "0005_registry_versions": versions,
    "0006_rollouts": rollouts,
    "0007_stored_ref_targets": targets,
    "0008_cells": cells,
  }),
});
