import type { Command } from '@commander-js/extra-typings';
import {
  CONTINUOUS_OWNER_TURNS_CAPABILITY,
  LOGICAL_TURN_RECOVERY_CAPABILITY,
} from '@yevgetman/sov-sdk/agent/logicalTurn';
import { loadSettings } from '@yevgetman/sov-sdk/config/loader';
import {
  getRoute,
  imageRoutes,
  inspectRouteCredential,
  listRoutes,
} from '@yevgetman/sov-sdk/providers/routes/index';
import { macKeychainPort } from '@yevgetman/sov-sdk/providers/subscription/keychain';
// The machine discovery surface is read-only. It never creates a provider,
// refreshes a token, starts a listener, or performs a network request.
import {
  modelPage,
  readModelCatalog,
  readModelCatalogSnapshot,
  routeWithOwnerModels,
} from './modelDiscovery.js';
import { importOwnerSubscriptionRegistry, readOwnerRegistryFile } from './ownerModelRegistry.js';

export const SOV_ROUTE_CAPABILITIES = {
  schemaVersion: 1,
  sdkRun: true,
  skillSettings: {
    schemaVersion: 1,
    sources: ['node-local', 'profile-settings', 'profile-config'],
    listPolicy: 'replace',
    approvalFileOption: '--skill-approval-file',
    doctorSchemaVersion: 1,
  },
  modelDiscovery: {
    schemaVersion: 1,
    command: 'models',
    explicitRefresh: true,
    offlineDefault: true,
    ownerRegistry: {
      route: 'grok-subscription',
      routes: ['grok-subscription', 'chatgpt-subscription'],
      importOption: '--registry',
      schemaVersion: 1,
    },
  },
  logicalTurnRecovery: LOGICAL_TURN_RECOVERY_CAPABILITY,
  continuousOwnerTurns: CONTINUOUS_OWNER_TURNS_CAPABILITY,
  routes: true,
  structuredInput: true,
  toolsets: true,
  images: true,
  imageRoutes: imageRoutes(),
  steering: true,
  jsonl: true,
  inputVersion: 1,
};

export function registerRouteCommands(program: Command): void {
  program
    .command('capabilities')
    .description('Show the versioned native SDK machine contract (no network).')
    .option('--json', 'emit non-secret versioned JSON')
    .action(() => {
      print(SOV_ROUTE_CAPABILITIES);
    });
  program
    .command('routes')
    .description('List built-in authentication routes, models, and efforts (no network).')
    .option('--json', 'emit non-secret versioned JSON')
    .action(() => {
      const settings = loadSettings();
      print({
        schemaVersion: 1,
        routes: listRoutes(settings).map((route) =>
          ['grok-subscription', 'chatgpt-subscription'].includes(route.id)
            ? routeWithOwnerModels(route, readModelCatalogSnapshot(route.id, settings))
            : route,
        ),
      });
    });
  program
    .command('models')
    .description('Discover route-scoped models; offline unless --refresh is explicit.')
    .requiredOption('--route <id>', 'authentication route')
    .option('--json', 'versioned JSON')
    .option('--registry <file>', 'replace owner-reviewed subscription registry (requires login)')
    .option('--refresh', 'refresh metadata without inference or subscription-token refresh')
    .option('--search <text>', 'filter ID and display name')
    .option('--author <id>', 'filter OpenRouter author (not inference host)')
    .option('--offset <n>', 'zero-based offset', '0')
    .option('--limit <n>', 'page size 1–100', '50')
    .action(async (opts) => {
      try {
        const query = {
          route: opts.route,
          offset: Number(opts.offset),
          limit: Number(opts.limit),
          ...(opts.search !== undefined ? { search: opts.search } : {}),
          ...(opts.author !== undefined ? { author: opts.author } : {}),
        };
        // Validate pagination before a possible explicit network refresh.
        modelPage({ version: 1, routeId: opts.route, models: [], state: 'unavailable' }, query);
        if (
          opts.registry &&
          (!['grok-subscription', 'chatgpt-subscription'].includes(opts.route) || opts.refresh)
        )
          throw new Error('Invalid registry request');
        const catalog = opts.registry
          ? await importOwnerSubscriptionRegistry(
              readOwnerRegistryFile(opts.registry),
              opts.route as 'grok-subscription' | 'chatgpt-subscription',
            )
          : await readModelCatalog(opts.route, loadSettings(), !!opts.refresh);
        print(modelPage(catalog, query));
      } catch {
        print({
          schemaVersion: 1,
          error: {
            code: 'invalid_model_query',
            message: opts.registry
              ? 'Invalid owner registry or subscription login unavailable. No registry changes were saved.'
              : 'Invalid route or model query.',
          },
        });
        process.exitCode = 2;
      }
    });
  program
    .command('auth')
    .description('Read local authentication state without refreshing credentials.')
    .command('status')
    .requiredOption('--route <id>', 'built-in authentication route id')
    .option('--json', 'emit non-secret versioned JSON')
    .action(async (opts) => {
      const settings = loadSettings();
      const route = getRoute(opts.route, settings);
      const status = await inspectRouteCredential(route, {
        settings,
        env: process.env,
        ...(route.auth === 'subscription'
          ? { subscriptionPort: macKeychainPort({ timeoutMs: 4_000 }) }
          : {}),
      });
      print({
        schemaVersion: 1,
        route: route.id,
        provider: route.provider,
        auth: route.auth,
        ...status,
      });
    });
}
function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
