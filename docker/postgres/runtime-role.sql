\getenv app_user APP_DB_USER
\getenv app_password APP_DB_PASSWORD
\getenv admin_user PGUSER
\getenv database_name PGDATABASE

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'app_user', :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'app_user', :'app_password'
)
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'app_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO %I', :'app_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO %I', :'admin_user', :'app_user') \gexec

SELECT format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.wallet_ledger_entries FROM %I', :'app_user')
WHERE to_regclass('public.wallet_ledger_entries') IS NOT NULL
\gexec
SELECT format('GRANT SELECT, INSERT ON TABLE public.wallet_ledger_entries TO %I', :'app_user')
WHERE to_regclass('public.wallet_ledger_entries') IS NOT NULL
\gexec
