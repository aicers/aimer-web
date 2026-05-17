import { createPhase2MutationHandler } from "../_shared/mutation-handler";
import { executeWithdraw, withdrawPayloadSchema } from "../_shared/withdraw";

export const POST = createPhase2MutationHandler({
  expectedSchemaVersion: "phase2.withdraw.v1",
  payloadSchema: withdrawPayloadSchema,
  auditTargetType: "phase2_withdraw",
  successAction: "phase2.withdraw",
  mutate: async (customerPool, _verified, payload) => {
    const counts = await executeWithdraw(customerPool, payload);
    return {
      responseBody: {
        withdrawn: counts.withdrawn,
        not_found: counts.notFound,
      },
      auditDetails: {
        withdrawn: counts.withdrawn,
        notFound: counts.notFound,
        kindsTouched: counts.kindsTouched,
      },
    };
  },
});
