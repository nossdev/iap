import { Capacitor } from '@capacitor/core';

export type RuntimePlatform = 'ios' | 'android' | 'web';

export function getPlatform(): RuntimePlatform {
  const platform = Capacitor.getPlatform();
  if (platform === 'ios' || platform === 'android') return platform;
  return 'web';
}

export function isNative(): boolean {
  const platform = getPlatform();
  return platform === 'ios' || platform === 'android';
}
