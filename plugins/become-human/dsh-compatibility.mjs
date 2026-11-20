const webVersion = '0.2.0-rc.2';
const desktopVersions = ['0.2.2-rc.3', '0.2.2-rc.5'];

// The private worker has its own profile name, but uses the host's DSH ABI.
export function supportedRuntimeVersion(version) {
  return version === webVersion || desktopVersions.includes(version);
}

export function supportedHostVersion(profile, version) {
  return profile === 'desktop' ? desktopVersions.includes(version) : version === webVersion;
}

export function supportedHostDescription(profile) {
  return profile === 'desktop' ? 'DSH Desktop ' + desktopVersions.join(' 或 ') : 'DSH Web ' + webVersion;
}
