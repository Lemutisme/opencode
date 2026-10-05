-- Persisted by unmodified historical Core/Schema services at 5b79856fd4.
-- Synthetic local fixture only: no user database, credentials, or provider calls.
-- The pre-policy schema, capped contracts, active bindings, support attestation,
-- and append-only ledger were produced by actual issue/activate/reportReady/
-- principalAttest/claim/reserveTurn/reserveAction calls, then SQLite .dump.
-- Historical deadline-only Contracts cannot exist here: that Schema required caps.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE `workspace` (
          `id` text PRIMARY KEY,
          `type` text NOT NULL,
          `name` text DEFAULT '' NOT NULL,
          `branch` text,
          `directory` text,
          `extra` text,
          `project_id` text NOT NULL,
          `time_used` integer NOT NULL,
          CONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `data_migration` (
          `name` text PRIMARY KEY,
          `time_completed` integer NOT NULL
        );
CREATE TABLE `account_state` (
          `id` integer PRIMARY KEY,
          `active_account_id` text,
          `active_org_id` text,
          CONSTRAINT `fk_account_state_active_account_id_account_id_fk` FOREIGN KEY (`active_account_id`) REFERENCES `account`(`id`) ON DELETE SET NULL
        );
CREATE TABLE `account` (
          `id` text PRIMARY KEY,
          `email` text NOT NULL,
          `url` text NOT NULL,
          `access_token` text NOT NULL,
          `refresh_token` text NOT NULL,
          `token_expiry` integer,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
CREATE TABLE `control_account` (
          `email` text NOT NULL,
          `url` text NOT NULL,
          `access_token` text NOT NULL,
          `refresh_token` text NOT NULL,
          `token_expiry` integer,
          `active` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `control_account_pk` PRIMARY KEY(`email`, `url`)
        );
CREATE TABLE `credential` (
          `id` text PRIMARY KEY,
          `integration_id` text,
          `label` text NOT NULL,
          `value` text NOT NULL,
          `connector_id` text,
          `method_id` text,
          `active` integer,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
CREATE TABLE `event_sequence` (
          `aggregate_id` text PRIMARY KEY,
          `seq` integer NOT NULL,
          `owner_id` text
        );
CREATE TABLE `event` (
          `id` text PRIMARY KEY,
          `aggregate_id` text NOT NULL,
          `seq` integer NOT NULL,
          `type` text NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_event_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
        );
CREATE TABLE `permission` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `action` text NOT NULL,
          `resource` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `fk_permission_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `pro_contract_attestation` (
          `id` text PRIMARY KEY,
          `contract_id` text NOT NULL,
          `data` text NOT NULL,
          `time_created` integer NOT NULL
        );
INSERT INTO pro_contract_attestation VALUES('pca_109d4a372001YkUeClkh1dFltJ','pct_upgrade_support','{"id":"pca_109d4a372001YkUeClkh1dFltJ","revision":1,"specHash":"e1b012dd81ed8329f215c18b981c39215df0cdbd5c3f67e75bba3e96f4905c70","subjectHash":"historical-snapshot","evidenceHash":"historical-independent-evidence","verifierID":"local-owner","class":"principal","contractID":"pct_upgrade_support"}',1791166292852);
CREATE TABLE `pro_contract_event` (
          `seq` integer PRIMARY KEY,
          `contract_id` text NOT NULL,
          `command` text NOT NULL,
          `decision` text NOT NULL,
          `previous_hash` text NOT NULL,
          `hash` text NOT NULL,
          `time_created` integer NOT NULL
        );
INSERT INTO pro_contract_event VALUES(0,'pct_upgrade_support','{"type":"issue","actor":"local-owner","draft":{"id":"pct_upgrade_support","scope":"upgrade","spec":{"trigger":{"type":"immediate"},"goal":"Historical policy support","brief":"","requires":[],"authority":["filesystem.read"],"budget":{"turns":4,"actions":32,"deadline":1750086400000},"evidence":{"type":"principal","claim":"Historical policy support"},"resolution":{"maxAttempts":3,"retryDelay":60000}},"issuer":"local-owner","executor":"opencode","specHash":"e1b012dd81ed8329f215c18b981c39215df0cdbd5c3f67e75bba3e96f4905c70"}}','{"type":"accepted"}','0000000000000000000000000000000000000000000000000000000000000000','89698a1522b72efc3c9d4b19745ddf6ac233525e287f361f73d11aeedc690a57',1791166292844);
INSERT INTO pro_contract_event VALUES(1,'pct_upgrade_support','{"type":"activate","actor":"institution","contractID":"pct_upgrade_support","revision":1,"time":1750000000000}','{"type":"accepted"}','89698a1522b72efc3c9d4b19745ddf6ac233525e287f361f73d11aeedc690a57','c680f556ccc6f929e0c52f10ca050cba9c2581d4bb213bfbe97254f587ce805c',1791166292847);
INSERT INTO pro_contract_event VALUES(2,'pct_upgrade_support','{"type":"report-ready","actor":"institution","contractID":"pct_upgrade_support","revision":1,"subjectHash":"historical-snapshot","summary":"Historical support","uncertainties":[],"time":1750000000001}','{"type":"accepted"}','c680f556ccc6f929e0c52f10ca050cba9c2581d4bb213bfbe97254f587ce805c','fd7925f2eb894cd45ccd469435ee94238f08ba462693fb45126e7bad9ef36ba1',1791166292849);
INSERT INTO pro_contract_event VALUES(3,'pct_upgrade_support','{"type":"discharge","actor":"local-owner","contractID":"pct_upgrade_support","attestation":{"id":"pca_109d4a372001YkUeClkh1dFltJ","revision":1,"specHash":"e1b012dd81ed8329f215c18b981c39215df0cdbd5c3f67e75bba3e96f4905c70","subjectHash":"historical-snapshot","evidenceHash":"historical-independent-evidence","verifierID":"local-owner","class":"principal"}}','{"type":"accepted"}','fd7925f2eb894cd45ccd469435ee94238f08ba462693fb45126e7bad9ef36ba1','d259a932671a1455de88fc6ab8f9846f13624cdceb56351b13f0f353d5abf41a',1791166292852);
INSERT INTO pro_contract_event VALUES(4,'pct_upgrade_capped','{"type":"issue","actor":"local-owner","draft":{"id":"pct_upgrade_capped","scope":"upgrade","spec":{"trigger":{"type":"immediate"},"goal":"Historical capped execution","brief":"","requires":[],"authority":["filesystem.read"],"budget":{"turns":4,"actions":32,"deadline":1750021600000},"evidence":{"type":"principal","claim":"Historical capped execution"},"resolution":{"maxAttempts":3,"retryDelay":60000}},"issuer":"local-owner","executor":"opencode","specHash":"ed2cd5d2573dd0d6e9f4bcb577ddce4bbc22f0b7157226d0126de7ae6195e8b4"}}','{"type":"accepted"}','d259a932671a1455de88fc6ab8f9846f13624cdceb56351b13f0f353d5abf41a','23d33936ab883cd667e2e64dac21c87fa50bbb9c987f1530c08985863f4bb29d',1791166292855);
INSERT INTO pro_contract_event VALUES(5,'pct_upgrade_capped','{"type":"activate","actor":"institution","contractID":"pct_upgrade_capped","revision":1,"time":1750000000000}','{"type":"accepted"}','23d33936ab883cd667e2e64dac21c87fa50bbb9c987f1530c08985863f4bb29d','19b9c3d74d4f11318bcb8966c62c261084ceea04a1f431e73f7e13531f77a40e',1791166292860);
INSERT INTO pro_contract_event VALUES(6,'pct_upgrade_bound_policy','{"type":"issue","actor":"local-owner","draft":{"id":"pct_upgrade_bound_policy","scope":"upgrade","spec":{"trigger":{"type":"immediate"},"goal":"Historical policy-bound execution","brief":"","requires":[{"contractID":"pct_upgrade_support","revision":1}],"authority":["filesystem.read"],"budget":{"turns":4,"actions":32,"deadline":1750021600000},"evidence":{"type":"principal","claim":"Historical policy-bound execution"},"resolution":{"maxAttempts":3,"retryDelay":60000}},"issuer":"local-owner","executor":"opencode","specHash":"275fa90efc3dae3b69685ab5a5f6c9b0d766d5ed6a8b872a8ba3801bb1e25a3f"}}','{"type":"accepted"}','19b9c3d74d4f11318bcb8966c62c261084ceea04a1f431e73f7e13531f77a40e','cd048d65cbf260986e205d661fb5a90ca2c2908fd722977ce86fa19b9b3f406c',1791166292878);
INSERT INTO pro_contract_event VALUES(7,'pct_upgrade_bound_policy','{"type":"activate","actor":"institution","contractID":"pct_upgrade_bound_policy","revision":1,"time":1750000000000}','{"type":"accepted"}','cd048d65cbf260986e205d661fb5a90ca2c2908fd722977ce86fa19b9b3f406c','909ee285b5c8d2b5a0ec335992dac41fc7aff1c9c0f279f280491c5ba7b2779a',1791166292881);
CREATE TABLE `pro_contract_ledger` (
          `id` integer PRIMARY KEY,
          `head_seq` integer NOT NULL,
          `head_hash` text NOT NULL
        );
INSERT INTO pro_contract_ledger VALUES(1,7,'909ee285b5c8d2b5a0ec335992dac41fc7aff1c9c0f279f280491c5ba7b2779a');
CREATE TABLE `pro_contract_opencode_session` (
          `session_id` text PRIMARY KEY,
          `contract_id` text NOT NULL
        );
INSERT INTO pro_contract_opencode_session VALUES('ses_ef62b5c87ffeFFcbLEUgPw54LA','pct_upgrade_capped');
INSERT INTO pro_contract_opencode_session VALUES('ses_ef62b5c70ffe7snjqI4ql8Vzmh','pct_upgrade_bound_policy');
CREATE TABLE `pro_contract_opencode` (
          `contract_id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `data` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
INSERT INTO pro_contract_opencode VALUES('pct_upgrade_capped','ses_ef62b5c87ffeFFcbLEUgPw54LA','{"contractID":"pct_upgrade_capped","revision":1,"location":{"directory":"/historical-fixture/project"},"model":{"id":"no-provider-call","providerID":"fixture"},"sessionID":"ses_ef62b5c87ffeFFcbLEUgPw54LA","promptID":"msg_109d4a378002ZOHqg2djRH1Vn2","dispatched":true,"attempts":1,"nextActionAt":1750000030000,"turnsUsed":1,"actionsUsed":1,"attemptKey":"1:","leaseOwner":"0533e540-18c1-4331-826f-396edd55ef98","leaseExpiresAt":1750000030000}',1791166292856,1791166292876);
INSERT INTO pro_contract_opencode VALUES('pct_upgrade_bound_policy','ses_ef62b5c70ffe7snjqI4ql8Vzmh','{"contractID":"pct_upgrade_bound_policy","revision":1,"location":{"directory":"/historical-fixture/project"},"model":{"id":"no-provider-call","providerID":"fixture"},"executionPolicy":"Frozen historical solver policy","sessionID":"ses_ef62b5c70ffe7snjqI4ql8Vzmh","promptID":"msg_109d4a38f002l4ci3W1JFMAmqB","dispatched":true,"attempts":1,"nextActionAt":1750000030000,"turnsUsed":1,"actionsUsed":1,"attemptKey":"1:","leaseOwner":"0533e540-18c1-4331-826f-396edd55ef98","leaseExpiresAt":1750000030000}',1791166292879,1791166292884);
CREATE TABLE `pro_contract` (
          `id` text PRIMARY KEY,
          `scope` text NOT NULL,
          `status` text NOT NULL,
          `data` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
INSERT INTO pro_contract VALUES('pct_upgrade_support','upgrade','discharged','{"id":"pct_upgrade_support","scope":"upgrade","spec":{"trigger":{"type":"immediate"},"goal":"Historical policy support","brief":"","requires":[],"authority":["filesystem.read"],"budget":{"turns":4,"actions":32,"deadline":1750086400000},"evidence":{"type":"principal","claim":"Historical policy support"},"resolution":{"maxAttempts":3,"retryDelay":60000}},"issuer":"local-owner","executor":"opencode","specHash":"e1b012dd81ed8329f215c18b981c39215df0cdbd5c3f67e75bba3e96f4905c70","revision":1,"status":"discharged","handoff":{"summary":"Historical support","uncertainties":[],"subjectHash":"historical-snapshot","time":1750000000001},"attestationID":"pca_109d4a372001YkUeClkh1dFltJ"}',1791166292843,1791166292851);
INSERT INTO pro_contract VALUES('pct_upgrade_capped','upgrade','active','{"id":"pct_upgrade_capped","scope":"upgrade","spec":{"trigger":{"type":"immediate"},"goal":"Historical capped execution","brief":"","requires":[],"authority":["filesystem.read"],"budget":{"turns":4,"actions":32,"deadline":1750021600000},"evidence":{"type":"principal","claim":"Historical capped execution"},"resolution":{"maxAttempts":3,"retryDelay":60000}},"issuer":"local-owner","executor":"opencode","specHash":"ed2cd5d2573dd0d6e9f4bcb577ddce4bbc22f0b7157226d0126de7ae6195e8b4","revision":1,"status":"active"}',1791166292854,1791166292859);
INSERT INTO pro_contract VALUES('pct_upgrade_bound_policy','upgrade','active','{"id":"pct_upgrade_bound_policy","scope":"upgrade","spec":{"trigger":{"type":"immediate"},"goal":"Historical policy-bound execution","brief":"","requires":[{"contractID":"pct_upgrade_support","revision":1}],"authority":["filesystem.read"],"budget":{"turns":4,"actions":32,"deadline":1750021600000},"evidence":{"type":"principal","claim":"Historical policy-bound execution"},"resolution":{"maxAttempts":3,"retryDelay":60000}},"issuer":"local-owner","executor":"opencode","specHash":"275fa90efc3dae3b69685ab5a5f6c9b0d766d5ed6a8b872a8ba3801bb1e25a3f","revision":1,"status":"active"}',1791166292878,1791166292880);
CREATE TABLE `project_directory` (
          `project_id` text NOT NULL,
          `directory` text NOT NULL,
          `type` text,
          `strategy` text,
          `time_created` integer NOT NULL,
          CONSTRAINT `project_directory_pk` PRIMARY KEY(`project_id`, `directory`),
          CONSTRAINT `fk_project_directory_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `project` (
          `id` text PRIMARY KEY,
          `worktree` text NOT NULL,
          `vcs` text,
          `name` text,
          `icon_url` text,
          `icon_url_override` text,
          `icon_color` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_initialized` integer,
          `sandboxes` text NOT NULL,
          `commands` text
        );
CREATE TABLE `message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `part` (
          `id` text PRIMARY KEY,
          `message_id` text NOT NULL,
          `session_id` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session_context_epoch` (
          `session_id` text PRIMARY KEY,
          `baseline` text NOT NULL,
          `snapshot` text NOT NULL,
          `baseline_seq` integer NOT NULL,
          CONSTRAINT `fk_session_context_epoch_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session_input` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `prompt` text NOT NULL,
          `delivery` text NOT NULL,
          `admitted_seq` integer NOT NULL,
          `promoted_seq` integer,
          `time_created` integer NOT NULL,
          CONSTRAINT `fk_session_input_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session_message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text NOT NULL,
          `version` text NOT NULL,
          `share_url` text,
          `summary_additions` integer,
          `summary_deletions` integer,
          `summary_files` integer,
          `summary_diffs` text,
          `metadata` text,
          `cost` real DEFAULT 0 NOT NULL,
          `tokens_input` integer DEFAULT 0 NOT NULL,
          `tokens_output` integer DEFAULT 0 NOT NULL,
          `tokens_reasoning` integer DEFAULT 0 NOT NULL,
          `tokens_cache_read` integer DEFAULT 0 NOT NULL,
          `tokens_cache_write` integer DEFAULT 0 NOT NULL,
          `revert` text,
          `permission` text,
          `agent` text,
          `model` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_compacting` integer,
          `time_archived` integer,
          CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `todo` (
          `session_id` text NOT NULL,
          `content` text NOT NULL,
          `status` text NOT NULL,
          `priority` text NOT NULL,
          `position` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `todo_pk` PRIMARY KEY(`session_id`, `position`),
          CONSTRAINT `fk_todo_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session_share` (
          `session_id` text PRIMARY KEY,
          `id` text NOT NULL,
          `secret` text NOT NULL,
          `url` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `fk_session_share_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE IF NOT EXISTS "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
INSERT INTO migration VALUES('20260127222353_familiar_lady_ursula',1791166292823);
INSERT INTO migration VALUES('20260211171708_add_project_commands',1791166292823);
INSERT INTO migration VALUES('20260213144116_wakeful_the_professor',1791166292823);
INSERT INTO migration VALUES('20260225215848_workspace',1791166292823);
INSERT INTO migration VALUES('20260227213759_add_session_workspace_id',1791166292823);
INSERT INTO migration VALUES('20260228203230_blue_harpoon',1791166292824);
INSERT INTO migration VALUES('20260303231226_add_workspace_fields',1791166292824);
INSERT INTO migration VALUES('20260309230000_move_org_to_state',1791166292824);
INSERT INTO migration VALUES('20260312043431_session_message_cursor',1791166292824);
INSERT INTO migration VALUES('20260323234822_events',1791166292824);
INSERT INTO migration VALUES('20260410174513_workspace-name',1791166292824);
INSERT INTO migration VALUES('20260413175956_chief_energizer',1791166292824);
INSERT INTO migration VALUES('20260423070820_add_icon_url_override',1791166292824);
INSERT INTO migration VALUES('20260427172553_slow_nightmare',1791166292824);
INSERT INTO migration VALUES('20260428004200_add_session_path',1791166292825);
INSERT INTO migration VALUES('20260501142318_next_venus',1791166292825);
INSERT INTO migration VALUES('20260504145000_add_sync_owner',1791166292825);
INSERT INTO migration VALUES('20260507164347_add_workspace_time',1791166292825);
INSERT INTO migration VALUES('20260510033149_session_usage',1791166292826);
INSERT INTO migration VALUES('20260511000411_data_migration_state',1791166292826);
INSERT INTO migration VALUES('20260511173437_session-metadata',1791166292826);
INSERT INTO migration VALUES('20260601010001_normalize_storage_paths',1791166292826);
INSERT INTO migration VALUES('20260601202201_amazing_prowler',1791166292826);
INSERT INTO migration VALUES('20260602002951_lowly_union_jack',1791166292826);
INSERT INTO migration VALUES('20260602182828_add_project_directories',1791166292826);
INSERT INTO migration VALUES('20260603001617_session_message_projection_indexes',1791166292826);
INSERT INTO migration VALUES('20260603040000_session_message_projection_order',1791166292827);
INSERT INTO migration VALUES('20260603141458_session_input_inbox',1791166292827);
INSERT INTO migration VALUES('20260603160727_jittery_ezekiel_stane',1791166292827);
INSERT INTO migration VALUES('20260604172448_event_sourced_session_input',1791166292827);
INSERT INTO migration VALUES('20260605003541_add_session_context_snapshot',1791166292827);
INSERT INTO migration VALUES('20260605042240_add_context_epoch_agent',1791166292827);
INSERT INTO migration VALUES('20260611035744_credential',1791166292827);
INSERT INTO migration VALUES('20260611192811_lush_chimera',1791166292827);
INSERT INTO migration VALUES('20260612174303_project_dir_strategy',1791166292828);
INSERT INTO migration VALUES('20260622142730_simplify_session_context_epoch',1791166292828);
INSERT INTO migration VALUES('20260622170816_reset_v2_session_state',1791166292828);
INSERT INTO migration VALUES('20260622202450_simplify_session_input',1791166292828);
INSERT INTO migration VALUES('20260722175817_pro_contract',1791166292828);
INSERT INTO migration VALUES('20260725003944_contract_sessions',1791166292828);
INSERT INTO migration VALUES('20260725235000_contract_phases',1791166292828);
CREATE UNIQUE INDEX `event_aggregate_seq_idx` ON `event` (`aggregate_id`,`seq`);
CREATE INDEX `event_aggregate_type_seq_idx` ON `event` (`aggregate_id`,`type`,`seq`);
CREATE UNIQUE INDEX `permission_project_action_resource_idx` ON `permission` (`project_id`,`action`,`resource`);
CREATE INDEX `pro_contract_attestation_contract_idx` ON `pro_contract_attestation` (`contract_id`);
CREATE INDEX `pro_contract_event_contract_seq_idx` ON `pro_contract_event` (`contract_id`,`seq`);
CREATE INDEX `pro_contract_opencode_session_contract_idx` ON `pro_contract_opencode_session` (`contract_id`);
CREATE UNIQUE INDEX `pro_contract_opencode_session_idx` ON `pro_contract_opencode` (`session_id`);
CREATE INDEX `pro_contract_scope_status_idx` ON `pro_contract` (`scope`,`status`);
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
CREATE INDEX `part_session_idx` ON `part` (`session_id`);
CREATE INDEX `session_input_session_pending_delivery_seq_idx` ON `session_input` (`session_id`,`promoted_seq`,`delivery`,`admitted_seq`);
CREATE UNIQUE INDEX `session_input_session_admitted_seq_idx` ON `session_input` (`session_id`,`admitted_seq`);
CREATE UNIQUE INDEX `session_input_session_promoted_seq_idx` ON `session_input` (`session_id`,`promoted_seq`);
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`,`type`,`seq`);
CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`);
CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);
CREATE INDEX `session_project_idx` ON `session` (`project_id`);
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);
CREATE INDEX `todo_session_idx` ON `todo` (`session_id`);
COMMIT;
