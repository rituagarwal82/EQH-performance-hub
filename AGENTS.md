<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Agency (Sabhi) emails read only sabhi_* DB functions; account is derived from the lead's ad, never leads.ad_account_id, and excluded accounts are hard-coded in sabhi_bucket_of_account — why: the stored field stopped being written on 21 Sep and two accounts are not our product/traffic.
- TagMango payments/enrolments sync iterates the live TagMango product list (EXCLUDED_PRODUCTS in tagmango-payments.server.ts is the only way to skip one); sale status is decided downstream by products.tier/counts_as_sale — why: a hardcoded 4-product list hid all Diamond, AMP and gift data.
