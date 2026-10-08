---
title: Fixed assets
nextjs:
  metadata:
    title: Fixed assets
    description: Track equipment, vehicles and property in WeldBooks, depreciate them in a book (GAAP) and in federal and state tax books with MACRS, section 179 and bonus depreciation, and record disposals.
screenshots_todo:
  - file: weldbooks-us-add-asset.png
    shows: Add fixed asset with a 5-year computer, the Expense or capitalize? check and the Depreciation books preview
  - file: weldbooks-us-asset-detail.png
    shows: An asset's page with Depreciation by book (Book and Federal tax) and the ledger postings
  - file: weldbooks-us-tax-depreciation.png
    shows: Tax depreciation for a tax year in the shape of Form 4562, with the mid-quarter test
---

Equipment, vehicles and property you use for years are fixed assets: you spread their cost over their life instead of expensing it at once. WeldBooks keeps the depreciation for your books and, for a US entity, the separate depreciation for your tax return. {% .lead %}

---

## Add an asset

1. Open **Fixed assets** and click **Add asset**.
2. Fill in the asset:
   - **Name**, **Asset number** and **Description**.
   - **Property class**: the MACRS class, for example **5-year property (vehicles, computers)** or **7-year property (furniture, machinery)**. It sets the federal tax book.
   - **Acquisition date** and **Placed in service** (blank means the acquisition date).
   - **Cost**, including any sales tax you paid, and the **Salvage value** for your books.
   - **Business use %** (blank is 100%). Tax books depreciate only the business share.
   - **Listed property**: a vehicle or other equipment that can be used privately. Used 50% or less for business, it must use the slower ADS method, with no section 179 or bonus.
   - **Useful life (years)** for your books.
   - **Section 179 expense** and **Bonus depreciation %**, if you take them (see below).
   - The **Fixed asset**, **Accumulated depreciation** and **Depreciation expense** accounts, and optionally a class and location.
3. Check the **Depreciation books** preview and click **Create asset**.

### Expense or capitalize?

While you enter the cost, WeldBooks checks the de minimis safe harbor. Items up to $2,500 per invoice or item ($5,000 if your business has an audited financial statement) can be expensed instead of capitalized. The election is made on your tax return for the whole year and covers every qualifying purchase, so decide it with your accountant.

### From a bill line

You can also turn a line on a bill into an asset: on the bill, choose **Create fixed asset** for that line. The cost, date and description come from the line; check them and choose the property class. Tick **Move the cost to the asset account** to post an entry that moves the cost from the account the line was booked to onto the fixed asset account.

---

## Depreciation books

Each asset can have several books that depreciate the same asset by their own rules:

| Book | Rules | Posts to the ledger |
| --- | --- | --- |
| **Book (GAAP)** | Your own method and useful life, usually straight line | Yes, through the depreciation run |
| **Federal tax** | MACRS (GDS or ADS) for the property class, with section 179 and bonus | No, it is for the return |
| **State tax** | For a state that doesn't follow the federal rules | No |

WeldBooks creates the default books from what you enter. Click **Customize the books** to choose each book's method, convention, life, section 179 and bonus yourself, or to add a state book.

Things WeldBooks handles in the federal book:

- **Conventions**: half-year by default. When more than 40% of a year's depreciable basis is placed in service in the last quarter, all of that year's property moves to the mid-quarter convention.
- **Section 179**: deducted in the first year, up to the limit. WeldBooks lowers it to the amount allowed when it is too high.
- **Bonus depreciation** follows the dates: 100% for property acquired and placed in service after January 19, 2025, with an election for a reduced 40% bonus in the first year after that date. Earlier property follows the phase-down that applied when it was placed in service. Leave the field blank to follow these rules, or enter a percentage.
- **Listed property** used 50% or less for business is converted to ADS.

When WeldBooks adjusts something, the asset shows **Notes on the depreciation**. Review them with your tax preparer.

---

## Run depreciation

The book (GAAP) depreciation reaches your ledger through the depreciation run.

1. On **Fixed assets**, click **Run depreciation**.
2. Choose **Post through**: by default the end of last month.
3. Click **Post depreciation** and confirm.

Every month not posted yet becomes one journal entry. Months in a locked or closed period are skipped and listed, so you can unlock them and run again. You can reverse an entry afterwards, but not undo the run.

Once depreciation has been posted for an asset, its cost, dates, accounts and books can't change any more. You can still edit its name, number, notes and location.

---

## Dispose of an asset

When you sell, scrap or retire an asset:

1. Open it and click **Dispose**.
2. Enter the **Disposal date**, the **Proceeds** (0 when scrapped), the account the proceeds were received in, and the gain or loss account.
3. Check the **Gain or loss preview** and click **Dispose of asset**.

WeldBooks posts the depreciation up to the disposal date, removes the asset from the books and records the gain or loss. For the tax books it shows the gain or loss on the return with the recapture: ordinary income under section 1245, unrecaptured section 1250 gain, and the remaining section 1231 gain.

An asset with posted depreciation can't be deleted. Dispose of it instead.

---

## Tax depreciation report

On **Fixed assets**, click **Tax depreciation** and choose the **Tax year** and the book (federal, or a state). The report follows the shape of Form 4562:

- **Part I**: the section 179 election, with the limit and the reduction;
- **Part II**: bonus depreciation on property placed in service this year;
- **Part III**: MACRS depreciation, split into earlier years and this year by class, convention and method;
- **Part V**: listed property;

followed by the mid-quarter test for the year and a line per asset. It is a summary to prepare the return from; check it with your tax preparer before filing.

---

## Next steps

- [Reports and tax calendar](/weldbooks/us/reports)
- [Payroll import](/weldbooks/us/payroll-import)
- [WeldBooks for US businesses](/weldbooks/us)
