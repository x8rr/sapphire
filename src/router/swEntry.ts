
import { shouldRoute, route } from "./SapphireRouter";

declare const self: ServiceWorkerGlobalScope;

(self as unknown as { $sapphireRouter: { shouldRoute: typeof shouldRoute; route: typeof route } }).$sapphireRouter = {
  shouldRoute,
  route,
};
