import { IPaymentProvider, PaymentChargeRequest, PaymentChargeResult, PaymentRefundResult } from './payment.interface';
import { logger } from '../observability/logger';
import crypto from 'crypto';

export class MockPaymentProvider implements IPaymentProvider {
  private simulateFailure = false;

  public setSimulateFailure(fail: boolean): void {
    this.simulateFailure = fail;
  }

  async charge(request: PaymentChargeRequest): Promise<PaymentChargeResult> {
    logger.info({ consultationId: request.consultationId, amountCents: request.amountCents }, 'MockPaymentProvider: processing charge');

    // Honor explicit failure flag (useful for testing sagas)
    if (request.forceFail || this.simulateFailure) {
      logger.warn({ consultationId: request.consultationId }, 'MockPaymentProvider: simulating payment failure');
      return {
        success: false,
        providerRef: `mock_failed_${crypto.randomUUID()}`,
        amountCents: request.amountCents,
        currency: request.currency,
        status: 'failed',
        errorMessage: 'Card declined: Insufficient funds or fraud suspicion'
      };
    }

    return {
      success: true,
      providerRef: `mock_ch_${crypto.randomUUID()}`,
      amountCents: request.amountCents,
      currency: request.currency,
      status: 'captured'
    };
  }

  async refund(providerRef: string, amountCents: number): Promise<PaymentRefundResult> {
    logger.info({ providerRef, amountCents }, 'MockPaymentProvider: processing refund');
    return {
      success: true,
      refundRef: `mock_rf_${crypto.randomUUID()}`,
      status: 'refunded'
    };
  }
}
