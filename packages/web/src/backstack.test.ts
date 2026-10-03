import { describe, expect, it, vi } from 'vitest';
import { handleBack } from './backstack';

describe('handleBack with nothing registered', () => {
  it('does nothing and says so, so the app can leave', () => {
    expect(handleBack()).toBe(false);
  });
});
