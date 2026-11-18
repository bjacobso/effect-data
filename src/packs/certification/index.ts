import { definePack } from "../../Packs.ts";
import { requirementKind, ops } from "./documents.ts";
import { CertificationGroup, CertificationHttpLive } from "./http.ts";
export const certificationPack = definePack({
  name: "certification",
  kinds: [requirementKind],
  ops,
  group: CertificationGroup,
  handlers: CertificationHttpLive,
});
