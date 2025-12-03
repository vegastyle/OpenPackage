import { registryResolver } from '../src/core/registry-resolver.js';

function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} expected ${expected} but received ${actual}`);
  }
}

function expectTrue(value: boolean, label: string): void {
  if (!value) {
    throw new Error(`${label} expected truthy value`);
  }
}

function expectArrayLength<T>(arr: T[], expected: number, label: string): void {
  if (arr.length !== expected) {
    throw new Error(`${label} expected length ${expected} but received ${arr.length}`);
  }
}

console.log('Running registry resolver tests...\n');

// Test 1: detectRegistryType - URLs
const httpUrlType = registryResolver.detectRegistryType('http://localhost:3000');
expectEqual(httpUrlType, 'remote', 'http URL detected as remote');

const httpsUrlType = registryResolver.detectRegistryType('https://registry.example.com');
expectEqual(httpsUrlType, 'remote', 'https URL detected as remote');

// Test 2: detectRegistryType - IP addresses
const ipType = registryResolver.detectRegistryType('192.168.1.100:3000');
expectEqual(ipType, 'remote', 'IP address detected as remote');

const ipNoPortType = registryResolver.detectRegistryType('10.0.0.1');
expectEqual(ipNoPortType, 'remote', 'IP address without port detected as remote');

// Test 3: detectRegistryType - Local paths
const localPathType = registryResolver.detectRegistryType('/home/user/.openpackage/registry');
expectEqual(localPathType, 'local', 'absolute path detected as local');

const relativePathType = registryResolver.detectRegistryType('./my-registry');
expectEqual(relativePathType, 'local', 'relative path detected as local');

const windowsPathType = registryResolver.detectRegistryType('C:\\Users\\Test\\registry');
expectEqual(windowsPathType, 'local', 'Windows path detected as local');

console.log('✓ Registry type detection tests passed\n');

// Test 4: resolveRegistries - Custom registries only
const customOnly = registryResolver.resolveRegistries({
  customRegistries: ['https://custom1.com', '/local/registry'],
  noDefaultRegistry: true,
  localOnly: false,
  remoteOnly: false
});

expectArrayLength(customOnly, 2, 'custom only resolves 2 registries');
expectEqual(customOnly[0].url, 'https://custom1.com', 'first custom registry URL');
expectEqual(customOnly[0].type, 'remote', 'first custom registry type');
expectEqual(customOnly[0].priority, 0, 'first custom registry priority');
expectEqual(customOnly[1].url, '/local/registry', 'second custom registry URL');
expectEqual(customOnly[1].type, 'local', 'second custom registry type');
expectEqual(customOnly[1].priority, 1, 'second custom registry priority');

console.log('✓ Custom registries only test passed\n');

// Test 5: resolveRegistries - Custom + Defaults
const customWithDefaults = registryResolver.resolveRegistries({
  customRegistries: ['https://custom.com'],
  noDefaultRegistry: false,
  localOnly: false,
  remoteOnly: false
});

expectTrue(customWithDefaults.length >= 3, 'custom + defaults has at least 3 registries');
expectEqual(customWithDefaults[0].url, 'https://custom.com', 'custom registry has highest priority');
expectEqual(customWithDefaults[0].priority, 0, 'custom registry priority is 0');

console.log('✓ Custom with defaults test passed\n');

// Test 6: resolveRegistries - Local only filter
const localOnlyRegistries = registryResolver.resolveRegistries({
  customRegistries: ['https://remote.com', '/local/path'],
  noDefaultRegistry: false,
  localOnly: true,
  remoteOnly: false
});

// Should only have local registries (custom local + default local)
expectTrue(localOnlyRegistries.length >= 1, 'local only has at least 1 registry');
expectTrue(
  localOnlyRegistries.every(r => r.type === 'local'),
  'local only filter includes only local registries'
);

console.log('✓ Local only filter test passed\n');

// Test 7: resolveRegistries - Remote only filter
const remoteOnlyRegistries = registryResolver.resolveRegistries({
  customRegistries: ['https://remote.com', '/local/path'],
  noDefaultRegistry: false,
  localOnly: false,
  remoteOnly: true
});

// Should only have remote registries (custom remote + default remote)
expectTrue(remoteOnlyRegistries.length >= 1, 'remote only has at least 1 registry');
expectTrue(
  remoteOnlyRegistries.every(r => r.type === 'remote'),
  'remote only filter includes only remote registries'
);

console.log('✓ Remote only filter test passed\n');

// Test 8: resolveRegistries - Priority ordering
const multipleCustom = registryResolver.resolveRegistries({
  customRegistries: ['https://first.com', 'https://second.com', '/third/local'],
  noDefaultRegistry: true,
  localOnly: false,
  remoteOnly: false
});

expectArrayLength(multipleCustom, 3, 'multiple custom registries resolved');
expectEqual(multipleCustom[0].priority, 0, 'first priority is 0');
expectEqual(multipleCustom[1].priority, 1, 'second priority is 1');
expectEqual(multipleCustom[2].priority, 2, 'third priority is 2');
expectTrue(
  multipleCustom[0].priority < multipleCustom[1].priority &&
  multipleCustom[1].priority < multipleCustom[2].priority,
  'priorities are in ascending order'
);

console.log('✓ Priority ordering test passed\n');

// Test 9: resolveRegistries - Empty custom registries
const defaultsOnly = registryResolver.resolveRegistries({
  customRegistries: [],
  noDefaultRegistry: false,
  localOnly: false,
  remoteOnly: false
});

expectTrue(defaultsOnly.length >= 2, 'defaults only has at least 2 registries (local + remote)');

console.log('✓ Empty custom registries test passed\n');

// Test 10: resolveRegistries - No registries when excluding defaults with no custom
const noRegistries = registryResolver.resolveRegistries({
  customRegistries: [],
  noDefaultRegistry: true,
  localOnly: false,
  remoteOnly: false
});

expectArrayLength(noRegistries, 0, 'no registries when excluding defaults with no custom');

console.log('✓ No registries test passed\n');

console.log('✅ All registry resolver tests passed!');
