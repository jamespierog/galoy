import { isSha256Hash } from "@domain/bitcoin"
import { InputValidationError } from "@graphql/error"
import { GT } from "@graphql/index"

const PaymentHash = GT.Scalar({
  name: "PaymentHash",
  parseValue(value) {
    return validPaymentHash(value)
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.STRING) {
      return validPaymentHash(ast.value)
    }
    return new InputValidationError({ message: "Invalid type for PaymentHash" })
  },
})

function validPaymentHash(value) {
  return isSha256Hash(value)
    ? value
    : new InputValidationError({ message: "Invalid value for PaymentHash" })
}

export default PaymentHash
