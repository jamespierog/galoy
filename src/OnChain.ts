const lnService = require('ln-service');
import { assert } from "console";
import { intersection, last } from "lodash";
import moment from "moment";
import { customerPath, lndAccountingPath } from "./ledger";
import { disposer } from "./lock";
import { MainBook, Transaction, User } from "./mongodb";
import { IOnChainPayment, ISuccess, ITransaction } from "./types";
import { amountOnVout, bitcoindDefaultClient, btc2sat, getAuth, LoggedError, LOOK_BACK, myOwnAddressesOnVout } from "./utils";
import { UserWallet } from "./wallet";

const using = require('bluebird').using

// TODO: look if tokens/amount has an effect on the fees
// we don't want to go back and forth between RN and the backend if amount changes
// but fees are the same
const someAmount = 50000

export const OnChainMixin = (superclass) => class extends superclass {
  lnd = lnService.authenticatedLndGrpc(getAuth()).lnd
  private currency = "BTC"

  constructor(...args) {
    super(...args)
  }

  async updatePending(): Promise<void> {
    await Promise.all([
      this.updateOnchainReceipt(),
      super.updatePending()
    ])
  }

  // FIXME: should be static but doesn't work with mixin
  // this would return a User if address belong to our wallet
  async tentativelyGetPayeeUser({address}) { 
    return User.findOne({ onchain_addresses: { $in: address } })
  }

  async getOnchainFee({address}: {address: string}): Promise<number> {
    const payeeUser = await this.tentativelyGetPayeeUser({address})

    let fee

    if (payeeUser) {
      fee = 0
    } else {
      const sendTo = [{ address, tokens: someAmount }];
      ({ fee } = await lnService.getChainFeeEstimate({ lnd: this.lnd, send_to: sendTo }))
    }

    return fee
  }

  // amount in sats
  async onChainPay({ address, amount, memo }: IOnChainPayment): Promise<ISuccess> {
    let onchainLogger = this.logger.child({ topic: "payment", protocol: "onchain", transactionType: "payment", address, amount, memo })

    const balance = await this.getBalances()
    onchainLogger = onchainLogger.child({ balance })

    // quit early if balance is not enough
    if (balance.total_in_BTC < amount) {
      const error = `balance is too low`
      onchainLogger.warn({ success: false, error }, error)
      throw new LoggedError(error)
    }

    const payeeUser = await this.tentativelyGetPayeeUser({address})

    if (payeeUser) {
      const onchainLoggerOnUs = onchainLogger.child({onUs: true})

      if (String(payeeUser._id) === String(this.uid)) {
        const error = 'User tried to pay himself'
        this.logger.warn({ payeeUser, error, success: false }, error)
        throw new LoggedError(error)
      }

      const sats = amount
      const metadata = { 
        currency: this.currency,
        type: "onchain_on_us",
        pending: false,
        ...UserWallet.getCurrencyEquivalent({ sats, fee: 0 }),
        payee_addresses: [address]
      }

      // TODO: this lock seems useless
      return await using(disposer(this.uid), async (lock) => {

        await MainBook.entry()
          .debit(customerPath(payeeUser._id), sats, metadata)
          .credit(this.user.accountPath, sats, {...metadata, memo})
          .commit()
        
        onchainLoggerOnUs.info({ success: true, ...metadata }, "onchain payment succeed")

        return true
      })
    }

    onchainLogger = onchainLogger.child({onUs: false})

    const { chain_balance: onChainBalance } = await lnService.getChainBalance({ lnd: this.lnd })

    let estimatedFee, id

    const sendTo = [{ address, tokens: amount }]

    try {
      ({ fee: estimatedFee } = await lnService.getChainFeeEstimate({ lnd: this.lnd, send_to: sendTo }))
    } catch (err) {
      const error = `Unable to estimate fee for on-chain transaction`
      onchainLogger.error({ err, sendTo, success: false }, error)
      throw new LoggedError(error)
    }

    // case where there is not enough money available within lnd on-chain wallet
    if (onChainBalance < amount + estimatedFee) {
      const error = `insufficient onchain balance on the lnd node. rebalancing is needed`
      
      // TODO: add a page to initiate the rebalancing quickly
      onchainLogger.fatal({onChainBalance, amount, estimatedFee, sendTo, success: false }, error)
      throw new LoggedError(error)
    }

    // case where the user doesn't have enough money
    if (balance.total_in_BTC < amount + estimatedFee) {
      const error = `balance is too low. have: ${balance} sats, need ${amount + estimatedFee}`
      onchainLogger.warn({balance, amount, estimatedFee, sendTo, success: false }, error)
      throw new LoggedError(error)
    }

    return await using(disposer(this.uid), async (lock) => {
      
      try {
        ({ id } = await lnService.sendToChainAddress({ address, lnd: this.lnd, tokens: amount }))
      } catch (err) {
        onchainLogger.error({ err, address, tokens: amount, success: false }, "Impossible to sendToChainAddress")
        return false
      }

      const outgoingOnchainTxns = await this.getOnChainTransactions({ lnd: this.lnd, incoming: false })

      const [{ fee }] = outgoingOnchainTxns.filter(tx => tx.id === id)

      {
        const sats = amount + fee
        const metadata = { currency: this.currency, hash: id, type: "onchain_payment", pending: true, ...UserWallet.getCurrencyEquivalent({ sats, fee }) }

        // TODO/FIXME refactor. add the transaction first and set the fees in a second tx.
        await MainBook.entry(memo)
          .debit(lndAccountingPath, sats, metadata)
          .credit(this.user.accountPath, sats, metadata)
          .commit()

        onchainLogger.info({success: true , ...metadata}, 'successfull onchain payment')
      }

      return true

    })

  }

  async getLastOnChainAddress(): Promise<string> {
    if (this.user.onchain_addresses.length === 0) {
      // FIXME this should not be done in a query but only in a mutation?
      await this.getOnChainAddress()
    }
 
    return last(this.user.onchain_addresses) as string
  }

  async getOnChainAddress(): Promise<string> {
    // another option to investigate is to have a master key / client
    // (maybe this could be saved in JWT)
    // and a way for them to derive new key
    // 
    // this would avoid a communication to the server 
    // every time you want to show a QR code.

    let address

    try {
      const format = 'p2wpkh';
      const response = await lnService.createChainAddress({
        lnd: this.lnd,
        format,
      })
      address = response.address
    } catch (err) {
      const error = `error getting on chain address`
      this.logger.error({err}, error)
      throw new LoggedError(error)
    }

    try {
      this.user.onchain_addresses.push(address)
      await this.user.save()

    } catch (err) {
      const error = `error storing new onchain address to db`
      this.logger.error({err}, error)
      throw new LoggedError(error)
    }

    return address
  }

  async getOnChainTransactions({ lnd, incoming }: { lnd: any, incoming: boolean }) {
    try {
      const { current_block_height } = await lnService.getHeight({lnd})
      const after = Math.max(0, current_block_height - LOOK_BACK) // this is necessary for tests, otherwise after may be negative
      const { transactions } = await lnService.getChainTransactions({ lnd, after })


      return transactions.filter(tx => incoming === !tx.is_outgoing)
    } catch (err) {
      const error = `issue fetching transaction`
      this.logger.error({err, incoming}, error)
      throw new LoggedError(error)
    }
  }

  async getOnchainReceipt({confirmed}: {confirmed: boolean}) {
    
    // optimization to remove the need to fetch lnd when no address
    // mainly useful for testing purpose
    // we could only generate an onchain_address the first time the client request it
    // as opposed to the first time the client log in
    if (!this.user.onchain_addresses.length) {
      return []
    }

    const lnd_incoming_txs = await this.getOnChainTransactions({ lnd: this.lnd, incoming: true })
    
    //        { block_id: '0000000000000b1fa86d936adb8dea741a9ecd5f6a58fc075a1894795007bdbc',
    //          confirmation_count: 712,
    //          confirmation_height: 1744148,
    //          created_at: '2020-05-14T01:47:22.000Z',
    //          fee: undefined,
    //          id: '5e3d3f679bbe703131b028056e37aee35a193f28c38d337a4aeb6600e5767feb',
    //          is_confirmed: true,
    //          is_outgoing: false,
    //          output_addresses: [Array],
    //          tokens: 10775,
    //          transaction: '020000000001.....' } ] }

    const lnd_incoming_filtered = lnd_incoming_txs.filter(tx => tx.is_confirmed === confirmed)

    const user_matched_txs = lnd_incoming_filtered.filter(tx => intersection(tx.output_addresses, this.user.onchain_addresses).length > 0)

    return user_matched_txs
  }

  async getTransactions(): Promise<Array<ITransaction>> {
    const confirmed = await super.getTransactions()

    //  ({
    //   created_at: moment(item.timestamp).unix(),
    //   amount: item.debit - item.credit,
    //   sat: item.sat,
    //   usd: item.usd,
    //   description: item.memoPayer || item.memo || item.type, // TODO remove `|| item.type` once users have upgraded
    //   type: item.type,
    //   hash: item.hash,
    //   fee: item.fee,
    //   feeUsd: item.feeUsd,
    //   // destination: TODO
    //   pending: item.pending,
    //   id: item._id,
    //   currency: item.currency
    //  })


    // TODO: only get onchain transaction as of the last 14 days to make the query faster, for now.
    // (transactions are ejected from mempool after 14 days by default)

    // TODO: should have outgoing unconfirmed transaction as well.
    // they are in medici, but not necessarily confirmed
    const unconfirmed = await this.getOnchainReceipt({confirmed: false})

    
    // {
    //   block_id: undefined,
    //   confirmation_count: undefined,
    //   confirmation_height: undefined,
    //   created_at: '2020-10-06T17:18:26.000Z',
    //   description: undefined,
    //   fee: undefined,
    //   id: '709dcc443014d14bf906b551d60cdb814d6f98f1caa3d40dcc49688175b2146a',
    //   is_confirmed: false,
    //   is_outgoing: false,
    //   output_addresses: [Array],
    //   tokens: 100000000,
    //   transaction: '020000000001019b5e33c844cc72b093683cec8f743f1ddbcf075077e5851cc8a598a844e684850100000000feffffff022054380c0100000016001499294eb1f4936f15472a891ba400dc09bfd0aa7b00e1f505000000001600146107c29ed16bf7712347ddb731af713e68f1a50702473044022016c03d070341b8954fe8f956ed1273bb3852d3b4ba0d798e090bb5fddde9321a022028dad050cac2e06fb20fad5b5bb6f1d2786306d90a1d8d82bf91e03a85e46fa70121024e3c0b200723dda6862327135ab70941a94d4f353c51f83921fcf4b5935eb80495000000'
    // }

    const unconfirmed_promise = unconfirmed.map(async ({ transaction, id, created_at }) => {
      const { sats, addresses } = await this.getSatsAndAddressPerTx(transaction)
      return { sats, addresses, id, created_at }
    })

    const unconfirmed_meta: any[] = await Promise.all(unconfirmed_promise)

    return [
      ...unconfirmed_meta.map(({ sats, addresses, id, created_at }) => ({
        id, 
        amount: sats,
        pending: true,
        created_at: moment(created_at).unix(),
        sat: sats,
        usd: UserWallet.satsToUsd(sats),
        description: "pending",
        type: "onchain_receipt",
        hash: id,
        currency: "BTC",
        fee: 0,
        feeUsd: 0,
        addresses
      })),
      ...confirmed
    ]
  }

  // raw encoded transaction
  async getSatsAndAddressPerTx(tx) {
    const {vout} = await bitcoindDefaultClient.decodeRawTransaction(tx)

    //   vout: [
    //   {
    //     value: 1,
    //     n: 0,
    //     scriptPubKey: {
    //       asm: '0 13584315784642a24d62c7dd1073f24c60604a10',
    //       hex: '001413584315784642a24d62c7dd1073f24c60604a10',
    //       reqSigs: 1,
    //       type: 'witness_v0_keyhash',
    //       addresses: [ 'bcrt1qzdvyx9tcgep2yntzclw3quljf3sxqjsszrwx2x' ]
    //     }
    //   },
    //   {
    //     value: 46.9999108,
    //     n: 1,
    //     scriptPubKey: {
    //       asm: '0 44c6e3f09c2462f9825e441a69d3f2c2325f3ab8',
    //       hex: '001444c6e3f09c2462f9825e441a69d3f2c2325f3ab8',
    //       reqSigs: 1,
    //       type: 'witness_v0_keyhash',
    //       addresses: [ 'bcrt1qgnrw8uyuy330nqj7gsdxn5ljcge97w4cu4c7m0' ]
    //     }
    //   }
    // ]

    // we have to look at the precise vout because lnd sums up the value at the transaction level, not at the vout level.
    // ie: if an attacker send 10 to user A at Galoy, and 10 to user B at galoy in a sinle transaction,
    // both would be credited 20, unless we do the below filtering.
    const value = amountOnVout({vout, onchain_addresses: this.user.onchain_addresses})
    const sats = btc2sat(value)

    const addresses = myOwnAddressesOnVout({vout, onchain_addresses: this.user.onchain_addresses})

    return { sats, addresses }
  }

  async updateOnchainReceipt() {
    const user_matched_txs = await this.getOnchainReceipt({confirmed: true})

    const type = "onchain_receipt"

    return await using(disposer(this.uid), async (lock) => {

      // FIXME O(n) ^ 2. bad.
      for (const matched_tx of user_matched_txs) {

        // has the transaction has not been added yet to the user account?
        //
        // note: the fact we fiter with `account_path: this.user.accountPath` could create 
        // double transaction for some non customer specific wallet. ie: if the path is different
        // for the broker. this is fixed now but something to think about.
        const mongotx = await Transaction.findOne({ accounts: this.user.accountPath, type, hash: matched_tx.id })

        // this.logger.debug({ matched_tx, mongotx }, "updateOnchainReceipt with user %o", this.uid)

        if (!mongotx) {

          const {sats, addresses} = await this.getSatsAndAddressPerTx(matched_tx.transaction)

          assert(matched_tx.tokens >= sats)

          const metadata = { 
            currency: this.currency,
            type, hash: matched_tx.id,
            pending: false,
            ...UserWallet.getCurrencyEquivalent({ sats, fee: 0 }),
            payee_addresses: addresses
          }

          await MainBook.entry()
            .debit(this.user.accountPath, sats, metadata)
            .credit(lndAccountingPath, sats, metadata)
            .commit()

          const onchainLogger = this.logger.child({ topic: "payment", protocol: "onchain", transactionType: "receipt", onUs: false })
          onchainLogger.info({ success: true, ...metadata })
        }

      }

    })
  }

};
