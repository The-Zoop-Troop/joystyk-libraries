import { expect, it } from 'vitest';
import { rateLimitKey } from './network.ts';

it.each([
  ['192.0.2.1', '192.0.2.1'],
  ['::ffff:192.0.2.1', '192.0.2.1'],
  ['::FFFF:c000:0201', '192.0.2.1'],
  ['2001:0DB8:ABCD:1234:abcd:0:0:1', '2001:db8:abcd:1234::/64'],
  ['2001:db8:abcd:1234::ffff', '2001:db8:abcd:1234::/64'],
  ['2001:db8::1', '2001:db8:0:0::/64'],
  ['2001:db8:abcd:1235::1', '2001:db8:abcd:1235::/64'],
  ['64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'],
  ['fe80::1%eth0', 'fe80:0:0:0::/64'],
  ['unknown', 'unknown'],
  ['invalid', 'unknown'],
])('uses one rate-limit key for %s', (address, key) => {
  expect(rateLimitKey(address)).toBe(key);
});
