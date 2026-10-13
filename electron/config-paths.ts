import path from 'node:path';
import { z } from 'zod';

const directoryEnvironment = z.object({
  OMP_PROFILE: z.string().optional(), PI_PROFILE: z.string().optional(),
  PI_CONFIG_DIR: z.string().optional(), PI_CODING_AGENT_DIR: z.string().optional(),
});

// Mirrors OMP pi-utils/dirs: PI_CONFIG_DIR is a dirname under home,
// "default" is the implicit profile, and named profiles ignore agent overrides.
export function resolveNativeAgentDirectory(home: string, environment: unknown, cwd: string): string {
  const env = directoryEnvironment.parse(environment);
  const selected = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  const profile = selected && selected !== 'default' ? selected : undefined;
  if (profile && (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile === '.' || profile === '..' || profile.endsWith('.') || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(profile))) {
    throw new Error('OMP 配置档名称无效；请使用合法的小写名称，不能包含路径或 Windows 保留设备名');
  }
  const root = path.join(home, env.PI_CONFIG_DIR || '.omp');
  if (profile) return path.join(root, 'profiles', profile, 'agent');
  return env.PI_CODING_AGENT_DIR ? path.resolve(cwd, env.PI_CODING_AGENT_DIR) : path.join(root, 'agent');
}
