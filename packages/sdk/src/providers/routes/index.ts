// Built-in SOV authentication routes: catalog, validation, credential
// inspection, provider resolution and stable error codes.

export {
  ROUTE_IDS,
  AUTO_SELECTION,
  isRouteId,
  type RouteId,
  type RouteAuth,
  type RouteProvider,
  type RouteRecord,
  type RouteSelection,
} from './types.js';
export {
  ROUTE_ERROR_CODES,
  RouteError,
  isRouteErrorCode,
  routeErrorCodeFor,
  type RouteErrorCode,
} from './errors.js';
export {
  ROUTE_IMAGE_SUPPORT,
  SUBSCRIPTION_ROUTE_EFFORTS,
  getRoute,
  imageRoutes,
  listRoutes,
  routeSupportsImages,
} from './catalog.js';
export { effortsForModel, validateRouteSelection, type RouteSelectionInput } from './validate.js';
export {
  DEFAULT_STATUS_TIMEOUT_MS,
  inspectRouteCredential,
  loginCommandFor,
  type CredentialState,
  type InspectRouteCredentialOpts,
  type RouteCredentialStatus,
} from './credentials.js';
export { resolveRouteProvider, type ResolveRouteOpts, type RouteResolution } from './resolve.js';
