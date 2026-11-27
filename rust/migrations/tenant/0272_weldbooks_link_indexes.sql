CREATE INDEX "acct_bank_txn_reconciled_payment_idx" ON "bank_transactions" USING btree ("reconciled_payment_id");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_contact_idx" ON "bank_transactions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_journal_entry_idx" ON "bank_transactions" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "acct_bank_txn_deposit_idx" ON "bank_transactions" USING btree ("deposit_id");--> statement-breakpoint
CREATE INDEX "acct_bills_source_document_idx" ON "bills" USING btree ("source_document_id");