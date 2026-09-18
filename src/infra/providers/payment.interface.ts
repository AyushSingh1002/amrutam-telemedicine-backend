export interface PaymentChargeRequest {
  consultationId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  forceFail?: boolean;
}

export interface PaymentChargeResult {
  success: boolean;
  providerRef: string;
  amountCents: number;
  currency: string;
  status: 'captured' | 'failed';
  errorMessage?: string;
}

export interface PaymentRefundResult {
  success: boolean;
  refundRef: string;
  status: 'refunded';
}

export interface IPaymentProvider {
  charge(request: PaymentChargeRequest): Promise<PaymentChargeResult>;
  refund(providerRef: string, amountCents: number): Promise<PaymentRefundResult>;
}
