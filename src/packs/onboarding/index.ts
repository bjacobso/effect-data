import { definePack } from "../../Packs.ts";
import { policyKind, ops } from "./documents.ts";
import { OnboardingGroup, OnboardingHttpLive } from "./http.ts";
export { evaluate } from "./documents.ts";
export const onboardingPack = definePack({
  name: "onboarding",
  kinds: [policyKind],
  ops,
  group: OnboardingGroup,
  handlers: OnboardingHttpLive,
});
