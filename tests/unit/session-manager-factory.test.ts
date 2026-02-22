import { describe, expect, it } from 'vitest';
import { GatewaySessionManager } from '../../src/gateway/client';
import {
  createDefaultSessionManager,
  SessionManager,
  shouldUseGatewaySessionManager
} from '../../src/session-manager';

describe('session manager factory', () => {
  it('uses gateway mode when IS_SANDBOX=1', () => {
    const env = {
      ...process.env,
      IS_SANDBOX: '1',
      DEV_SESSIONS_GATEWAY_URL: 'http://gateway.internal:6767'
    };

    expect(shouldUseGatewaySessionManager(env)).toBe(true);
    const manager = createDefaultSessionManager(env);
    expect(manager).toBeInstanceOf(GatewaySessionManager);
  });

  it('uses local mode when IS_SANDBOX is not set', () => {
    const env = {
      ...process.env
    };
    delete env.IS_SANDBOX;

    expect(shouldUseGatewaySessionManager(env)).toBe(false);
    const manager = createDefaultSessionManager(env);
    expect(manager).toBeInstanceOf(SessionManager);
  });
});
