# Transactional skill storage — issue 47

1. Define the explicit portable store, full-tree revision, pagination and event contract.
2. Implement in-memory validation/CAS and confined recoverable filesystem transactions.
3. Route all committed SOV skill writers through the contract; preserve in-flight catalogs.
4. Add effect-based, recovery and Node/Bun fixtures; document the current storage API.
5. Run the required lint/type/build/test gates, review the diff and create the issue PR.

Dependencies: none. Hand-off: issue 48 consumes committed events; issue 49 consumes
the injected store and paginated enumeration. Store revisions, activation content
revisions and registry generations are separate identities.
