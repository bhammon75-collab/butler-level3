export const stripeTools = {
  async read_connect_account({ accountId }:{ accountId:string }) {
    // Placeholder: call Stripe API with TEST key to fetch account capabilities
    return { id: accountId, charges_enabled: true, payouts_enabled: true }
  }
}
