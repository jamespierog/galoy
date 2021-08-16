import { toSats } from "@domain/bitcoin"
import { MakeTxFilter } from "@domain/bitcoin/onchain"

describe("TxFilter", () => {
  it("filters greater than equal to confs", () => {
    const filter = MakeTxFilter({ confirmationsGreaterThanOrEqual: 2 })
    const filteredTxs = filter.apply([
      {
        confirmations: 0,
        fee: toSats(10),
        id: "id" as TxId,
        outputAddresses: ["address"],
        tokens: toSats(10000),
        createdAt: new Date(),
      } as SubmittedTransaction,
      {
        confirmations: 2,
        fee: toSats(10),
        id: "id" as TxId,
        outputAddresses: ["address"],
        tokens: toSats(10000),
        createdAt: new Date(),
      } as SubmittedTransaction,
    ])

    expect(filteredTxs.length).toEqual(1)
  })

  it("filters less than confs", () => {
    const filter = MakeTxFilter({ confirmationsLessThan: 3 })
    const filteredTxs = filter.apply([
      {
        confirmations: 2,
        fee: toSats(10),
        id: "id" as TxId,
        outputAddresses: ["address"],
        tokens: toSats(10000),
        createdAt: new Date(),
      } as SubmittedTransaction,
      {
        confirmations: 3,
        fee: toSats(10),
        id: "id" as TxId,
        outputAddresses: ["address"],
        tokens: toSats(10000),
        createdAt: new Date(),
      } as SubmittedTransaction,
    ])

    expect(filteredTxs[0].confirmations).toEqual(2)
  })

  it("filters including addresses", () => {
    const filter = MakeTxFilter({ addresses: ["address1" as OnChainAddress] })
    const filteredTxs = filter.apply([
      {
        confirmations: 2,
        fee: toSats(10),
        id: "id" as TxId,
        outputAddresses: ["address1"],
        tokens: toSats(10000),
        createdAt: new Date(),
      } as SubmittedTransaction,
      {
        confirmations: 3,
        fee: toSats(10),
        id: "id" as TxId,
        outputAddresses: ["address2"],
        tokens: toSats(10000),
        createdAt: new Date(),
      } as SubmittedTransaction,
    ])

    expect(filteredTxs[0].outputAddresses[0]).toEqual("address1")
  })
})