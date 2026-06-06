import path from 'node:path';

export function resolveServicePaths({ root = process.cwd() } = {}) {
  const bypassDir = path.join(root, '.bypass');
  const serviceDir = path.join(bypassDir, 'service');
  const jobsDir = path.join(bypassDir, 'jobs');

  return {
    root,
    bypassDir,
    serviceDir,
    jobsDir,
    servicePidPath: path.join(serviceDir, 'service.pid'),
    serviceUrlPath: path.join(serviceDir, 'service-url'),
    serviceLogPath: path.join(serviceDir, 'service.log')
  };
}
