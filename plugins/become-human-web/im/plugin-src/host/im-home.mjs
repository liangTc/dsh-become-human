import path from 'node:path';

// A normal DSH profile launch need not export DSH_HOME. The manager passes
// its resolved directory; standalone registration uses the profile context.
export function resolveImHome(ctx, config = {}, environment = process.env) {
  if (config.dshHome !== undefined) {
    if (typeof config.dshHome !== 'string' || !path.isAbsolute(config.dshHome)) throw new Error('INVALID_IM_HOME');
    return config.dshHome;
  }
  const home = ctx?.profileContext?.home ?? environment.DSH_HOME;
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('INVALID_IM_HOME');
  return path.join(home, 'become-human-manager', 'im-home');
}
