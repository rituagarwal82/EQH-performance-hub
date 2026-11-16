export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ad_account_ownership: {
        Row: {
          account_id: string
          agency_code: string
          created_at: string
          note: string | null
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          account_id: string
          agency_code: string
          created_at?: string
          note?: string | null
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          account_id?: string
          agency_code?: string
          created_at?: string
          note?: string | null
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ad_account_ownership_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "ad_accounts"
            referencedColumns: ["account_id"]
          },
        ]
      }
      ad_accounts: {
        Row: {
          account_id: string
          account_role: string
          agency_code: string | null
          created_at: string
          currency: string
          is_active: boolean
          lead_tracking_status: string
          name: string
          status: string | null
        }
        Insert: {
          account_id: string
          account_role?: string
          agency_code?: string | null
          created_at?: string
          currency?: string
          is_active?: boolean
          lead_tracking_status?: string
          name: string
          status?: string | null
        }
        Update: {
          account_id?: string
          account_role?: string
          agency_code?: string | null
          created_at?: string
          currency?: string
          is_active?: boolean
          lead_tracking_status?: string
          name?: string
          status?: string | null
        }
        Relationships: []
      }
      ad_entities: {
        Row: {
          account_id: string
          agency_code: string | null
          creative_body: string | null
          creative_fetch_error: string | null
          creative_fetch_status: string | null
          creative_fetched_at: string | null
          creative_object_type: string | null
          creative_title: string | null
          entity_id: string
          level: string
          name: string | null
          parent_id: string | null
          permalink_url: string | null
          status: string | null
          thumbnail_url: string | null
          updated_at: string
        }
        Insert: {
          account_id: string
          agency_code?: string | null
          creative_body?: string | null
          creative_fetch_error?: string | null
          creative_fetch_status?: string | null
          creative_fetched_at?: string | null
          creative_object_type?: string | null
          creative_title?: string | null
          entity_id: string
          level: string
          name?: string | null
          parent_id?: string | null
          permalink_url?: string | null
          status?: string | null
          thumbnail_url?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          agency_code?: string | null
          creative_body?: string | null
          creative_fetch_error?: string | null
          creative_fetch_status?: string | null
          creative_fetched_at?: string | null
          creative_object_type?: string | null
          creative_title?: string | null
          entity_id?: string
          level?: string
          name?: string | null
          parent_id?: string | null
          permalink_url?: string | null
          status?: string | null
          thumbnail_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_entities_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "ad_accounts"
            referencedColumns: ["account_id"]
          },
        ]
      }
      ad_script_map: {
        Row: {
          ad_entity_id: string
          confidence: number
          created_at: string
          mapped_by: string
          note: string | null
          script_id: string
          updated_at: string
        }
        Insert: {
          ad_entity_id: string
          confidence?: number
          created_at?: string
          mapped_by: string
          note?: string | null
          script_id: string
          updated_at?: string
        }
        Update: {
          ad_entity_id?: string
          confidence?: number
          created_at?: string
          mapped_by?: string
          note?: string | null
          script_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_script_map_ad_entity_id_fkey"
            columns: ["ad_entity_id"]
            isOneToOne: true
            referencedRelation: "ad_entities"
            referencedColumns: ["entity_id"]
          },
          {
            foreignKeyName: "ad_script_map_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "creative_scripts"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_cohort: {
        Row: {
          buyers: number
          channel: string
          computed_at: string
          diamond_buyers: number
          followup_sales: number
          later_cash_90: number
          later_cash_per_buyer: number | null
          month: string
          no_attendance_sales: number
          other_timing_sales: number
          registrations: number
          show_up_pct: number | null
          show_ups: number
          too_few: boolean
          webinar_sales: number
          window_open: boolean
        }
        Insert: {
          buyers?: number
          channel: string
          computed_at?: string
          diamond_buyers?: number
          followup_sales?: number
          later_cash_90?: number
          later_cash_per_buyer?: number | null
          month: string
          no_attendance_sales?: number
          other_timing_sales?: number
          registrations?: number
          show_up_pct?: number | null
          show_ups?: number
          too_few?: boolean
          webinar_sales?: number
          window_open?: boolean
        }
        Update: {
          buyers?: number
          channel?: string
          computed_at?: string
          diamond_buyers?: number
          followup_sales?: number
          later_cash_90?: number
          later_cash_per_buyer?: number | null
          month?: string
          no_attendance_sales?: number
          other_timing_sales?: number
          registrations?: number
          show_up_pct?: number | null
          show_ups?: number
          too_few?: boolean
          webinar_sales?: number
          window_open?: boolean
        }
        Relationships: []
      }
      agency_email_log: {
        Row: {
          body_text: string | null
          kind: string
          last_error: string | null
          message_id: string | null
          period_key: string
          recipients: string[] | null
          refusals: Json | null
          sent_at: string | null
          status: string
          subject: string | null
          updated_at: string
        }
        Insert: {
          body_text?: string | null
          kind: string
          last_error?: string | null
          message_id?: string | null
          period_key: string
          recipients?: string[] | null
          refusals?: Json | null
          sent_at?: string | null
          status: string
          subject?: string | null
          updated_at?: string
        }
        Update: {
          body_text?: string | null
          kind?: string
          last_error?: string | null
          message_id?: string | null
          period_key?: string
          recipients?: string[] | null
          refusals?: Json | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      agency_month: {
        Row: {
          agency_code: string | null
          buyers: number
          cash: number
          channel: string
          computed_at: string
          cost_per_registration: number | null
          cost_per_sale: number | null
          cost_per_show_up: number | null
          diamond_buyers: number
          followup_sales: number
          front_end_return: number | null
          fully_paid: number
          later_cash_90: number
          later_cash_per_buyer: number | null
          month: string
          no_attendance_sales: number
          other_timing_sales: number
          ratios_ok: boolean
          ratios_reason: string | null
          registrations: number
          retarget_spend: number
          sales: number
          show_ups: number
          spend: number
          spend_known: boolean
          spend_note: string | null
          webinar_sales: number
          window_open: boolean
        }
        Insert: {
          agency_code?: string | null
          buyers?: number
          cash?: number
          channel: string
          computed_at?: string
          cost_per_registration?: number | null
          cost_per_sale?: number | null
          cost_per_show_up?: number | null
          diamond_buyers?: number
          followup_sales?: number
          front_end_return?: number | null
          fully_paid?: number
          later_cash_90?: number
          later_cash_per_buyer?: number | null
          month: string
          no_attendance_sales?: number
          other_timing_sales?: number
          ratios_ok?: boolean
          ratios_reason?: string | null
          registrations?: number
          retarget_spend?: number
          sales?: number
          show_ups?: number
          spend?: number
          spend_known?: boolean
          spend_note?: string | null
          webinar_sales?: number
          window_open?: boolean
        }
        Update: {
          agency_code?: string | null
          buyers?: number
          cash?: number
          channel?: string
          computed_at?: string
          cost_per_registration?: number | null
          cost_per_sale?: number | null
          cost_per_show_up?: number | null
          diamond_buyers?: number
          followup_sales?: number
          front_end_return?: number | null
          fully_paid?: number
          later_cash_90?: number
          later_cash_per_buyer?: number | null
          month?: string
          no_attendance_sales?: number
          other_timing_sales?: number
          ratios_ok?: boolean
          ratios_reason?: string | null
          registrations?: number
          retarget_spend?: number
          sales?: number
          show_ups?: number
          spend?: number
          spend_known?: boolean
          spend_note?: string | null
          webinar_sales?: number
          window_open?: boolean
        }
        Relationships: []
      }
      agency_open_items: {
        Row: {
          agency_code: string
          answered_note: string | null
          answered_on: string | null
          body: string
          created_at: string
          id: string
          ord: number
          raised_on: string
          status: string
        }
        Insert: {
          agency_code: string
          answered_note?: string | null
          answered_on?: string | null
          body: string
          created_at?: string
          id?: string
          ord: number
          raised_on: string
          status?: string
        }
        Update: {
          agency_code?: string
          answered_note?: string | null
          answered_on?: string | null
          body?: string
          created_at?: string
          id?: string
          ord?: number
          raised_on?: string
          status?: string
        }
        Relationships: []
      }
      agency_spend_status: {
        Row: {
          ad_coverage_pct: number | null
          agency_code: string
          note: string | null
          ratio_note: string | null
          ratios_computable: boolean
          ratios_hold: boolean
          ratios_hold_reason: string | null
          ratios_valid_from: string | null
          spend_synced: boolean
          updated_at: string
        }
        Insert: {
          ad_coverage_pct?: number | null
          agency_code: string
          note?: string | null
          ratio_note?: string | null
          ratios_computable?: boolean
          ratios_hold?: boolean
          ratios_hold_reason?: string | null
          ratios_valid_from?: string | null
          spend_synced?: boolean
          updated_at?: string
        }
        Update: {
          ad_coverage_pct?: number | null
          agency_code?: string
          note?: string | null
          ratio_note?: string | null
          ratios_computable?: boolean
          ratios_hold?: boolean
          ratios_hold_reason?: string | null
          ratios_valid_from?: string | null
          spend_synced?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      analyst_briefs: {
        Row: {
          attempts: number
          brief_md: string
          created_at: string
          evidence: Json
          for_date: string
          id: string
          model: string | null
          tokens: number | null
        }
        Insert: {
          attempts?: number
          brief_md: string
          created_at?: string
          evidence?: Json
          for_date: string
          id?: string
          model?: string | null
          tokens?: number | null
        }
        Update: {
          attempts?: number
          brief_md?: string
          created_at?: string
          evidence?: Json
          for_date?: string
          id?: string
          model?: string | null
          tokens?: number | null
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          value: string | null
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          value?: string | null
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          value?: string | null
        }
        Relationships: []
      }
      ask_knowledge: {
        Row: {
          body: string
          created_at: string
          id: string
          is_active: boolean
          kind: string
          ord: number
          source_note: string | null
          topic: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          is_active?: boolean
          kind?: string
          ord?: number
          source_note?: string | null
          topic: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          is_active?: boolean
          kind?: string
          ord?: number
          source_note?: string | null
          topic?: string
          updated_at?: string
        }
        Relationships: []
      }
      ask_log: {
        Row: {
          answer: string | null
          corroborated: boolean | null
          created_at: string
          duration_ms: number | null
          error: string | null
          id: string
          plan: Json | null
          question: string
          rows: number | null
          sql: string | null
          understood: string | null
        }
        Insert: {
          answer?: string | null
          corroborated?: boolean | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          plan?: Json | null
          question: string
          rows?: number | null
          sql?: string | null
          understood?: string | null
        }
        Update: {
          answer?: string | null
          corroborated?: boolean | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          plan?: Json | null
          question?: string
          rows?: number | null
          sql?: string | null
          understood?: string | null
        }
        Relationships: []
      }
      attribution_changes: {
        Row: {
          attempted_value: string | null
          email_key: string | null
          field: string
          id: string
          lead_id: string
          observed_at: string
          old_value: string | null
          source_system: string
        }
        Insert: {
          attempted_value?: string | null
          email_key?: string | null
          field: string
          id?: string
          lead_id: string
          observed_at?: string
          old_value?: string | null
          source_system?: string
        }
        Update: {
          attempted_value?: string | null
          email_key?: string | null
          field?: string
          id?: string
          lead_id?: string
          observed_at?: string
          old_value?: string | null
          source_system?: string
        }
        Relationships: []
      }
      buyer_classification: {
        Row: {
          bucket: string
          created_at: string
          decided_by: string
          decision: string
          email_key: string
          note: string | null
          updated_at: string
        }
        Insert: {
          bucket: string
          created_at?: string
          decided_by?: string
          decision: string
          email_key: string
          note?: string | null
          updated_at?: string
        }
        Update: {
          bucket?: string
          created_at?: string
          decided_by?: string
          decision?: string
          email_key?: string
          note?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      concept_draft_scripts: {
        Row: {
          body: string
          close: string
          concept_key: string
          created_at: string
          drew_on: string
          edited_by_owner: boolean
          evidence: Json
          hook: string
          id: string
          in_words: string
          model: string | null
          review_item_id: string
          updated_at: string
        }
        Insert: {
          body: string
          close: string
          concept_key: string
          created_at?: string
          drew_on: string
          edited_by_owner?: boolean
          evidence?: Json
          hook: string
          id?: string
          in_words: string
          model?: string | null
          review_item_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          close?: string
          concept_key?: string
          created_at?: string
          drew_on?: string
          edited_by_owner?: boolean
          evidence?: Json
          hook?: string
          id?: string
          in_words?: string
          model?: string | null
          review_item_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      concept_scripts: {
        Row: {
          added_at: string
          concept_id: string
          script_id: string
        }
        Insert: {
          added_at?: string
          concept_id: string
          script_id: string
        }
        Update: {
          added_at?: string
          concept_id?: string
          script_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "concept_scripts_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "concepts"
            referencedColumns: ["concept_id"]
          },
          {
            foreignKeyName: "concept_scripts_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "creative_scripts"
            referencedColumns: ["id"]
          },
        ]
      }
      concept_state_log: {
        Row: {
          concept_id: string
          created_at: string
          decided_by: string
          evidence: Json
          from_state: string | null
          id: string
          reason: string
          to_state: string
        }
        Insert: {
          concept_id: string
          created_at?: string
          decided_by?: string
          evidence?: Json
          from_state?: string | null
          id?: string
          reason: string
          to_state: string
        }
        Update: {
          concept_id?: string
          created_at?: string
          decided_by?: string
          evidence?: Json
          from_state?: string | null
          id?: string
          reason?: string
          to_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "concept_state_log_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "concepts"
            referencedColumns: ["concept_id"]
          },
        ]
      }
      concepts: {
        Row: {
          concept_id: string
          created_at: string
          name: string
          note: string | null
          opened_at: string
          pain: string
          persona: string
          promise: string
          reference_cpl: number | null
          state: string
          state_changed_at: string
          updated_at: string
        }
        Insert: {
          concept_id: string
          created_at?: string
          name: string
          note?: string | null
          opened_at?: string
          pain: string
          persona: string
          promise: string
          reference_cpl?: number | null
          state?: string
          state_changed_at?: string
          updated_at?: string
        }
        Update: {
          concept_id?: string
          created_at?: string
          name?: string
          note?: string | null
          opened_at?: string
          pain?: string
          persona?: string
          promise?: string
          reference_cpl?: number | null
          state?: string
          state_changed_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      creative_briefs: {
        Row: {
          approved: boolean
          approved_at: string | null
          attempts: number
          brief_md: string
          created_at: string
          evidence: Json
          for_date: string
          id: string
          model: string | null
          tokens: number | null
          updated_at: string
        }
        Insert: {
          approved?: boolean
          approved_at?: string | null
          attempts?: number
          brief_md: string
          created_at?: string
          evidence?: Json
          for_date: string
          id?: string
          model?: string | null
          tokens?: number | null
          updated_at?: string
        }
        Update: {
          approved?: boolean
          approved_at?: string | null
          attempts?: number
          brief_md?: string
          created_at?: string
          evidence?: Json
          for_date?: string
          id?: string
          model?: string | null
          tokens?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      creative_scripts: {
        Row: {
          created_at: string
          first_8s_hook: string | null
          id: string
          language: string
          script_code: string
          script_text: string | null
          source: string
          title: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          first_8s_hook?: string | null
          id?: string
          language?: string
          script_code: string
          script_text?: string | null
          source?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          first_8s_hook?: string | null
          id?: string
          language?: string
          script_code?: string
          script_text?: string | null
          source?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      credential_register: {
        Row: {
          expires_at: string | null
          how_to_renew: string | null
          key: string
          label: string
          note: string | null
          updated_at: string
          what_breaks: string
        }
        Insert: {
          expires_at?: string | null
          how_to_renew?: string | null
          key: string
          label: string
          note?: string | null
          updated_at?: string
          what_breaks: string
        }
        Update: {
          expires_at?: string | null
          how_to_renew?: string | null
          key?: string
          label?: string
          note?: string | null
          updated_at?: string
          what_breaks?: string
        }
        Relationships: []
      }
      cron_http_calls: {
        Row: {
          called_at: string
          jobname: string
          request_id: number
          url: string
        }
        Insert: {
          called_at?: string
          jobname: string
          request_id: number
          url: string
        }
        Update: {
          called_at?: string
          jobname?: string
          request_id?: number
          url?: string
        }
        Relationships: []
      }
      cron_manifest: {
        Row: {
          active: boolean
          body: Json
          consequence: string | null
          first_seen_at: string
          jobname: string
          max_gap_hours: number
          note: string | null
          plain_label: string | null
          schedule: string
          timeout_ms: number
          updated_at: string
          url_path: string
        }
        Insert: {
          active?: boolean
          body?: Json
          consequence?: string | null
          first_seen_at?: string
          jobname: string
          max_gap_hours?: number
          note?: string | null
          plain_label?: string | null
          schedule: string
          timeout_ms?: number
          updated_at?: string
          url_path: string
        }
        Update: {
          active?: boolean
          body?: Json
          consequence?: string | null
          first_seen_at?: string
          jobname?: string
          max_gap_hours?: number
          note?: string | null
          plain_label?: string | null
          schedule?: string
          timeout_ms?: number
          updated_at?: string
          url_path?: string
        }
        Relationships: []
      }
      daily_email_log: {
        Row: {
          attempts: number
          body_text: string | null
          business_date: string
          last_error: string | null
          recipients: string[] | null
          sent_at: string | null
          status: string
          subject: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          body_text?: string | null
          business_date: string
          last_error?: string | null
          recipients?: string[] | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          body_text?: string | null
          business_date?: string
          last_error?: string | null
          recipients?: string[] | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      daily_metrics: {
        Row: {
          account_id: string
          date: string
          entity_id: string | null
          id: string
          impressions: number
          landing_page_views: number | null
          leads: number | null
          level: string
          link_clicks: number
          placement: string | null
          purchases: number | null
          spend: number
          synced_at: string
        }
        Insert: {
          account_id: string
          date: string
          entity_id?: string | null
          id?: string
          impressions?: number
          landing_page_views?: number | null
          leads?: number | null
          level: string
          link_clicks?: number
          placement?: string | null
          purchases?: number | null
          spend?: number
          synced_at?: string
        }
        Update: {
          account_id?: string
          date?: string
          entity_id?: string | null
          id?: string
          impressions?: number
          landing_page_views?: number | null
          leads?: number | null
          level?: string
          link_clicks?: number
          placement?: string | null
          purchases?: number | null
          spend?: number
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_metrics_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "ad_accounts"
            referencedColumns: ["account_id"]
          },
        ]
      }
      demo_metrics: {
        Row: {
          account_id: string
          age_bucket: string
          date: string
          entity_id: string
          gender: string
          id: string
          impressions: number
          leads: number
          link_clicks: number
          spend: number
          synced_at: string
        }
        Insert: {
          account_id: string
          age_bucket?: string
          date: string
          entity_id: string
          gender?: string
          id?: string
          impressions?: number
          leads?: number
          link_clicks?: number
          spend?: number
          synced_at?: string
        }
        Update: {
          account_id?: string
          age_bucket?: string
          date?: string
          entity_id?: string
          gender?: string
          id?: string
          impressions?: number
          leads?: number
          link_clicks?: number
          spend?: number
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "demo_metrics_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "ad_accounts"
            referencedColumns: ["account_id"]
          },
        ]
      }
      deploys: {
        Row: {
          deploy_ref: string
          deployed_at: string
          goldens_fail: number
          goldens_pass: number
          invariants_diverged: number
          note: string | null
          verified_at: string | null
          verify_status: string
        }
        Insert: {
          deploy_ref: string
          deployed_at?: string
          goldens_fail?: number
          goldens_pass?: number
          invariants_diverged?: number
          note?: string | null
          verified_at?: string | null
          verify_status?: string
        }
        Update: {
          deploy_ref?: string
          deployed_at?: string
          goldens_fail?: number
          goldens_pass?: number
          invariants_diverged?: number
          note?: string | null
          verified_at?: string | null
          verify_status?: string
        }
        Relationships: []
      }
      experiment_assignments: {
        Row: {
          assigned_at: string
          experiment_key: string
          id: string
          lead_ref: string
          note: string | null
          variant: string
        }
        Insert: {
          assigned_at?: string
          experiment_key: string
          id?: string
          lead_ref: string
          note?: string | null
          variant: string
        }
        Update: {
          assigned_at?: string
          experiment_key?: string
          id?: string
          lead_ref?: string
          note?: string | null
          variant?: string
        }
        Relationships: []
      }
      feed_config: {
        Row: {
          cadence_hours: number
          feed: string
          forced_stale_at: string | null
          forced_stale_reason: string | null
          is_blocking: boolean
          label: string
          max_data_lag_days: number | null
          note: string | null
          sources: string[]
        }
        Insert: {
          cadence_hours?: number
          feed: string
          forced_stale_at?: string | null
          forced_stale_reason?: string | null
          is_blocking?: boolean
          label: string
          max_data_lag_days?: number | null
          note?: string | null
          sources?: string[]
        }
        Update: {
          cadence_hours?: number
          feed?: string
          forced_stale_at?: string | null
          forced_stale_reason?: string | null
          is_blocking?: boolean
          label?: string
          max_data_lag_days?: number | null
          note?: string | null
          sources?: string[]
        }
        Relationships: []
      }
      feed_edge_history: {
        Row: {
          coverage_edge: string | null
          feed: string
          observed_at: string
        }
        Insert: {
          coverage_edge?: string | null
          feed: string
          observed_at?: string
        }
        Update: {
          coverage_edge?: string | null
          feed?: string
          observed_at?: string
        }
        Relationships: []
      }
      golden_runs: {
        Row: {
          computed_value: number | null
          delta: number | null
          deploy_ref: string | null
          error: string | null
          golden_id: string
          id: string
          pass: boolean | null
          run_at: string
          trigger_kind: string
        }
        Insert: {
          computed_value?: number | null
          delta?: number | null
          deploy_ref?: string | null
          error?: string | null
          golden_id: string
          id?: string
          pass?: boolean | null
          run_at?: string
          trigger_kind: string
        }
        Update: {
          computed_value?: number | null
          delta?: number | null
          deploy_ref?: string | null
          error?: string | null
          golden_id?: string
          id?: string
          pass?: boolean | null
          run_at?: string
          trigger_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "golden_runs_golden_id_fkey"
            columns: ["golden_id"]
            isOneToOne: false
            referencedRelation: "golden_tests"
            referencedColumns: ["golden_id"]
          },
        ]
      }
      golden_tests: {
        Row: {
          contract_version: number
          created_at: string
          expected_value: number
          golden_id: string
          metric_id: string
          note: string | null
          regime_note: string | null
          spans_regime: boolean
          tolerance_abs: number | null
          tolerance_pct: number | null
          verified_by: string
          window_end: string
          window_start: string
        }
        Insert: {
          contract_version?: number
          created_at?: string
          expected_value: number
          golden_id: string
          metric_id: string
          note?: string | null
          regime_note?: string | null
          spans_regime?: boolean
          tolerance_abs?: number | null
          tolerance_pct?: number | null
          verified_by: string
          window_end: string
          window_start: string
        }
        Update: {
          contract_version?: number
          created_at?: string
          expected_value?: number
          golden_id?: string
          metric_id?: string
          note?: string | null
          regime_note?: string | null
          spans_regime?: boolean
          tolerance_abs?: number | null
          tolerance_pct?: number | null
          verified_by?: string
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      lead_source_month: {
        Row: {
          channel: string
          computed_at: string
          confidence: string
          leads: number
          month: string
          source: string
          tool: string | null
          tool_key: string
        }
        Insert: {
          channel: string
          computed_at?: string
          confidence: string
          leads?: number
          month: string
          source: string
          tool?: string | null
          tool_key: string
        }
        Update: {
          channel?: string
          computed_at?: string
          confidence?: string
          leads?: number
          month?: string
          source?: string
          tool?: string | null
          tool_key?: string
        }
        Relationships: []
      }
      lead_unified_source: {
        Row: {
          ident: string
          lead_id: string
          resolution_layer: string
          unified_channel: string
          unified_confidence: string
          unified_source: string
          unified_tool: string | null
          updated_at: string
        }
        Insert: {
          ident: string
          lead_id: string
          resolution_layer: string
          unified_channel: string
          unified_confidence: string
          unified_source: string
          unified_tool?: string | null
          updated_at?: string
        }
        Update: {
          ident?: string
          lead_id?: string
          resolution_layer?: string
          unified_channel?: string
          unified_confidence?: string
          unified_source?: string
          unified_tool?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      leads: {
        Row: {
          ad_account_id: string | null
          ad_entity_ref: string | null
          ad_id: string | null
          ad_match_type: string | null
          ad_matched_at: string | null
          adset_id: string | null
          agency_code: string | null
          business_date: string | null
          campaign_id: string | null
          captured_at: string | null
          email_key: string | null
          email_raw: string | null
          fbc: string | null
          fbclid: string | null
          fbp: string | null
          first_touch_ad_id: string | null
          first_touch_adset_id: string | null
          first_touch_agency_code: string | null
          first_touch_at: string | null
          first_touch_campaign_id: string | null
          first_touch_utm_campaign: string | null
          first_touch_utm_content: string | null
          first_touch_utm_medium: string | null
          first_touch_utm_source: string | null
          gclid: string | null
          inference_basis: string | null
          is_import: boolean
          is_registered: boolean
          landing_page: string | null
          lead_id: string
          name: string | null
          phone: string | null
          phone_key: string | null
          platform: string | null
          raw: Json | null
          registered_at: string | null
          source_inferred: string | null
          source_platform: string | null
          source_system: string
          synced_at: string
          tags: string[]
          utm_campaign: string | null
          utm_content: string | null
          utm_medium: string | null
          utm_placement: string | null
          utm_source: string | null
          utm_term: string | null
          webinar_date: string | null
          webinar_tag: string | null
          webinar_time: string | null
        }
        Insert: {
          ad_account_id?: string | null
          ad_entity_ref?: string | null
          ad_id?: string | null
          ad_match_type?: string | null
          ad_matched_at?: string | null
          adset_id?: string | null
          agency_code?: string | null
          business_date?: string | null
          campaign_id?: string | null
          captured_at?: string | null
          email_key?: string | null
          email_raw?: string | null
          fbc?: string | null
          fbclid?: string | null
          fbp?: string | null
          first_touch_ad_id?: string | null
          first_touch_adset_id?: string | null
          first_touch_agency_code?: string | null
          first_touch_at?: string | null
          first_touch_campaign_id?: string | null
          first_touch_utm_campaign?: string | null
          first_touch_utm_content?: string | null
          first_touch_utm_medium?: string | null
          first_touch_utm_source?: string | null
          gclid?: string | null
          inference_basis?: string | null
          is_import?: boolean
          is_registered?: boolean
          landing_page?: string | null
          lead_id: string
          name?: string | null
          phone?: string | null
          phone_key?: string | null
          platform?: string | null
          raw?: Json | null
          registered_at?: string | null
          source_inferred?: string | null
          source_platform?: string | null
          source_system: string
          synced_at?: string
          tags?: string[]
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_placement?: string | null
          utm_source?: string | null
          utm_term?: string | null
          webinar_date?: string | null
          webinar_tag?: string | null
          webinar_time?: string | null
        }
        Update: {
          ad_account_id?: string | null
          ad_entity_ref?: string | null
          ad_id?: string | null
          ad_match_type?: string | null
          ad_matched_at?: string | null
          adset_id?: string | null
          agency_code?: string | null
          business_date?: string | null
          campaign_id?: string | null
          captured_at?: string | null
          email_key?: string | null
          email_raw?: string | null
          fbc?: string | null
          fbclid?: string | null
          fbp?: string | null
          first_touch_ad_id?: string | null
          first_touch_adset_id?: string | null
          first_touch_agency_code?: string | null
          first_touch_at?: string | null
          first_touch_campaign_id?: string | null
          first_touch_utm_campaign?: string | null
          first_touch_utm_content?: string | null
          first_touch_utm_medium?: string | null
          first_touch_utm_source?: string | null
          gclid?: string | null
          inference_basis?: string | null
          is_import?: boolean
          is_registered?: boolean
          landing_page?: string | null
          lead_id?: string
          name?: string | null
          phone?: string | null
          phone_key?: string | null
          platform?: string | null
          raw?: Json | null
          registered_at?: string | null
          source_inferred?: string | null
          source_platform?: string | null
          source_system?: string
          synced_at?: string
          tags?: string[]
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_placement?: string | null
          utm_source?: string | null
          utm_term?: string | null
          webinar_date?: string | null
          webinar_tag?: string | null
          webinar_time?: string | null
        }
        Relationships: []
      }
      ledger_inflow: {
        Row: {
          amount_pending: number | null
          amount_received: number
          business_date: string | null
          counts_as_sale: boolean
          email_key: string | null
          email_raw: string | null
          imported_at: string
          is_new_sale: boolean
          is_seat_deposit: boolean
          payer_name: string | null
          payment_date: string | null
          payment_type: string | null
          product_raw: string | null
          product_tier: string | null
          receipt_source: string | null
          revenue_recognized: boolean
          row_hash: string
          sale_type: string | null
          seat_completed_at: string | null
          seat_completion_of: string | null
          sheet_row: number | null
          source_of_student_raw: string | null
        }
        Insert: {
          amount_pending?: number | null
          amount_received?: number
          business_date?: string | null
          counts_as_sale?: boolean
          email_key?: string | null
          email_raw?: string | null
          imported_at?: string
          is_new_sale?: boolean
          is_seat_deposit?: boolean
          payer_name?: string | null
          payment_date?: string | null
          payment_type?: string | null
          product_raw?: string | null
          product_tier?: string | null
          receipt_source?: string | null
          revenue_recognized?: boolean
          row_hash: string
          sale_type?: string | null
          seat_completed_at?: string | null
          seat_completion_of?: string | null
          sheet_row?: number | null
          source_of_student_raw?: string | null
        }
        Update: {
          amount_pending?: number | null
          amount_received?: number
          business_date?: string | null
          counts_as_sale?: boolean
          email_key?: string | null
          email_raw?: string | null
          imported_at?: string
          is_new_sale?: boolean
          is_seat_deposit?: boolean
          payer_name?: string | null
          payment_date?: string | null
          payment_type?: string | null
          product_raw?: string | null
          product_tier?: string | null
          receipt_source?: string | null
          revenue_recognized?: boolean
          row_hash?: string
          sale_type?: string | null
          seat_completed_at?: string | null
          seat_completion_of?: string | null
          sheet_row?: number | null
          source_of_student_raw?: string | null
        }
        Relationships: []
      }
      ledger_inflow_backup_20260907: {
        Row: {
          amount_pending: number | null
          amount_received: number | null
          business_date: string | null
          counts_as_sale: boolean | null
          email_key: string | null
          email_raw: string | null
          imported_at: string | null
          is_new_sale: boolean | null
          is_seat_deposit: boolean | null
          payer_name: string | null
          payment_date: string | null
          payment_type: string | null
          product_raw: string | null
          product_tier: string | null
          receipt_source: string | null
          revenue_recognized: boolean | null
          row_hash: string | null
          sale_type: string | null
          seat_completed_at: string | null
          seat_completion_of: string | null
          sheet_row: number | null
          source_of_student_raw: string | null
        }
        Insert: {
          amount_pending?: number | null
          amount_received?: number | null
          business_date?: string | null
          counts_as_sale?: boolean | null
          email_key?: string | null
          email_raw?: string | null
          imported_at?: string | null
          is_new_sale?: boolean | null
          is_seat_deposit?: boolean | null
          payer_name?: string | null
          payment_date?: string | null
          payment_type?: string | null
          product_raw?: string | null
          product_tier?: string | null
          receipt_source?: string | null
          revenue_recognized?: boolean | null
          row_hash?: string | null
          sale_type?: string | null
          seat_completed_at?: string | null
          seat_completion_of?: string | null
          sheet_row?: number | null
          source_of_student_raw?: string | null
        }
        Update: {
          amount_pending?: number | null
          amount_received?: number | null
          business_date?: string | null
          counts_as_sale?: boolean | null
          email_key?: string | null
          email_raw?: string | null
          imported_at?: string | null
          is_new_sale?: boolean | null
          is_seat_deposit?: boolean | null
          payer_name?: string | null
          payment_date?: string | null
          payment_type?: string | null
          product_raw?: string | null
          product_tier?: string | null
          receipt_source?: string | null
          revenue_recognized?: boolean | null
          row_hash?: string | null
          sale_type?: string | null
          seat_completed_at?: string | null
          seat_completion_of?: string | null
          sheet_row?: number | null
          source_of_student_raw?: string | null
        }
        Relationships: []
      }
      ledger_inflow_snapshots: {
        Row: {
          amount_pending: number | null
          amount_received: number
          business_date: string | null
          email_key: string | null
          email_raw: string | null
          is_new_sale: boolean
          payer_name: string | null
          payment_date: string | null
          payment_type: string | null
          product_raw: string | null
          product_tier: string | null
          receipt_source: string | null
          row_hash: string
          sale_type: string | null
          sheet_row: number | null
          snapshot_at: string
          source_of_student_raw: string | null
        }
        Insert: {
          amount_pending?: number | null
          amount_received?: number
          business_date?: string | null
          email_key?: string | null
          email_raw?: string | null
          is_new_sale?: boolean
          payer_name?: string | null
          payment_date?: string | null
          payment_type?: string | null
          product_raw?: string | null
          product_tier?: string | null
          receipt_source?: string | null
          row_hash: string
          sale_type?: string | null
          sheet_row?: number | null
          snapshot_at: string
          source_of_student_raw?: string | null
        }
        Update: {
          amount_pending?: number | null
          amount_received?: number
          business_date?: string | null
          email_key?: string | null
          email_raw?: string | null
          is_new_sale?: boolean
          payer_name?: string | null
          payment_date?: string | null
          payment_type?: string | null
          product_raw?: string | null
          product_tier?: string | null
          receipt_source?: string | null
          row_hash?: string
          sale_type?: string | null
          sheet_row?: number | null
          snapshot_at?: string
          source_of_student_raw?: string | null
        }
        Relationships: []
      }
      ledger_inflow_staging: {
        Row: {
          amount_pending: number | null
          amount_received: number
          business_date: string | null
          counts_as_sale: boolean
          email_key: string | null
          email_raw: string | null
          imported_at: string
          is_new_sale: boolean
          is_seat_deposit: boolean
          payer_name: string | null
          payment_date: string | null
          payment_type: string | null
          product_raw: string | null
          product_tier: string | null
          receipt_source: string | null
          revenue_recognized: boolean
          row_hash: string
          sale_type: string | null
          seat_completed_at: string | null
          seat_completion_of: string | null
          sheet_row: number | null
          source_of_student_raw: string | null
        }
        Insert: {
          amount_pending?: number | null
          amount_received?: number
          business_date?: string | null
          counts_as_sale?: boolean
          email_key?: string | null
          email_raw?: string | null
          imported_at?: string
          is_new_sale?: boolean
          is_seat_deposit?: boolean
          payer_name?: string | null
          payment_date?: string | null
          payment_type?: string | null
          product_raw?: string | null
          product_tier?: string | null
          receipt_source?: string | null
          revenue_recognized?: boolean
          row_hash: string
          sale_type?: string | null
          seat_completed_at?: string | null
          seat_completion_of?: string | null
          sheet_row?: number | null
          source_of_student_raw?: string | null
        }
        Update: {
          amount_pending?: number | null
          amount_received?: number
          business_date?: string | null
          counts_as_sale?: boolean
          email_key?: string | null
          email_raw?: string | null
          imported_at?: string
          is_new_sale?: boolean
          is_seat_deposit?: boolean
          payer_name?: string | null
          payment_date?: string | null
          payment_type?: string | null
          product_raw?: string | null
          product_tier?: string | null
          receipt_source?: string | null
          revenue_recognized?: boolean
          row_hash?: string
          sale_type?: string | null
          seat_completed_at?: string | null
          seat_completion_of?: string | null
          sheet_row?: number | null
          source_of_student_raw?: string | null
        }
        Relationships: []
      }
      metric_baselines: {
        Row: {
          computed_at: string
          grain: string
          mad: number | null
          median: number | null
          metric_id: string
          n_observations: number
          regime_note: string | null
          spans_regime: boolean
          weekday_class: string
        }
        Insert: {
          computed_at?: string
          grain: string
          mad?: number | null
          median?: number | null
          metric_id: string
          n_observations?: number
          regime_note?: string | null
          spans_regime?: boolean
          weekday_class: string
        }
        Update: {
          computed_at?: string
          grain?: string
          mad?: number | null
          median?: number | null
          metric_id?: string
          n_observations?: number
          regime_note?: string | null
          spans_regime?: boolean
          weekday_class?: string
        }
        Relationships: []
      }
      metric_contracts: {
        Row: {
          basis: string
          created_at: string
          grain: string
          is_current: boolean
          metric_id: string
          note: string | null
          owner_definition: string
          source_fingerprint: string | null
          source_function: string | null
          source_precedence: string | null
          unit: string
          updated_at: string
          version: number
        }
        Insert: {
          basis: string
          created_at?: string
          grain: string
          is_current?: boolean
          metric_id: string
          note?: string | null
          owner_definition: string
          source_fingerprint?: string | null
          source_function?: string | null
          source_precedence?: string | null
          unit: string
          updated_at?: string
          version?: number
        }
        Update: {
          basis?: string
          created_at?: string
          grain?: string
          is_current?: boolean
          metric_id?: string
          note?: string | null
          owner_definition?: string
          source_fingerprint?: string | null
          source_function?: string | null
          source_precedence?: string | null
          unit?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      metric_orphan_notes: {
        Row: {
          created_at: string
          entity_id: string
          noted_by: string
          reason: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          noted_by?: string
          reason: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          noted_by?: string
          reason?: string
          updated_at?: string
        }
        Relationships: []
      }
      owner_ruling_changes: {
        Row: {
          action: string
          after_value: Json | null
          before_value: Json | null
          changed_at: string
          changed_by: string | null
          id: string
          ruling_id: string | null
        }
        Insert: {
          action: string
          after_value?: Json | null
          before_value?: Json | null
          changed_at?: string
          changed_by?: string | null
          id?: string
          ruling_id?: string | null
        }
        Update: {
          action?: string
          after_value?: Json | null
          before_value?: Json | null
          changed_at?: string
          changed_by?: string | null
          id?: string
          ruling_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "owner_ruling_changes_ruling_id_fkey"
            columns: ["ruling_id"]
            isOneToOne: false
            referencedRelation: "owner_rulings"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_rulings: {
        Row: {
          body: string
          created_at: string
          decided_by: string
          decided_on: string | null
          id: string
          is_active: boolean
          ord: number
          section: string
          title: string
          updated_at: string
          why: string | null
        }
        Insert: {
          body: string
          created_at?: string
          decided_by?: string
          decided_on?: string | null
          id?: string
          is_active?: boolean
          ord?: number
          section: string
          title: string
          updated_at?: string
          why?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          decided_by?: string
          decided_on?: string | null
          id?: string
          is_active?: boolean
          ord?: number
          section?: string
          title?: string
          updated_at?: string
          why?: string | null
        }
        Relationships: []
      }
      person_links: {
        Row: {
          confirmed_by: string
          confirmed_on: string
          created_at: string
          linked_email: string | null
          linked_phone: string | null
          note: string | null
          payment_email: string
        }
        Insert: {
          confirmed_by?: string
          confirmed_on?: string
          created_at?: string
          linked_email?: string | null
          linked_phone?: string | null
          note?: string | null
          payment_email: string
        }
        Update: {
          confirmed_by?: string
          confirmed_on?: string
          created_at?: string
          linked_email?: string | null
          linked_phone?: string | null
          note?: string | null
          payment_email?: string
        }
        Relationships: []
      }
      products: {
        Row: {
          counts_as_sale: boolean
          created_at: string
          currency: string | null
          last_synced_at: string | null
          mango_id: string
          notes: string | null
          payment_route: string | null
          price: number | null
          product_type: string | null
          subscriber_count: number | null
          tier: string | null
          title: string
          updated_at: string
        }
        Insert: {
          counts_as_sale?: boolean
          created_at?: string
          currency?: string | null
          last_synced_at?: string | null
          mango_id: string
          notes?: string | null
          payment_route?: string | null
          price?: number | null
          product_type?: string | null
          subscriber_count?: number | null
          tier?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          counts_as_sale?: boolean
          created_at?: string
          currency?: string | null
          last_synced_at?: string | null
          mango_id?: string
          notes?: string | null
          payment_route?: string | null
          price?: number | null
          product_type?: string | null
          subscriber_count?: number | null
          tier?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      promotions: {
        Row: {
          code: string
          created_at: string
          dates_confirmed: boolean
          discounted_price: number
          ends_on: string | null
          is_active: boolean
          list_price: number
          name: string
          note: string | null
          starts_on: string | null
        }
        Insert: {
          code: string
          created_at?: string
          dates_confirmed?: boolean
          discounted_price: number
          ends_on?: string | null
          is_active?: boolean
          list_price?: number
          name: string
          note?: string | null
          starts_on?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          dates_confirmed?: boolean
          discounted_price?: number
          ends_on?: string | null
          is_active?: boolean
          list_price?: number
          name?: string
          note?: string | null
          starts_on?: string | null
        }
        Relationships: []
      }
      proof_registry: {
        Row: {
          check_id: string
          enabled: boolean
          expected_noise: string
          family: string
          fp_budget_per_30d: number
          label: string
          needs_recalibration: boolean
          ord: number
          plain: string
          recalibrated_at: string | null
          structural_note: string | null
          tolerance_note: string | null
          updated_at: string
        }
        Insert: {
          check_id: string
          enabled?: boolean
          expected_noise: string
          family: string
          fp_budget_per_30d: number
          label: string
          needs_recalibration?: boolean
          ord?: number
          plain: string
          recalibrated_at?: string | null
          structural_note?: string | null
          tolerance_note?: string | null
          updated_at?: string
        }
        Update: {
          check_id?: string
          enabled?: boolean
          expected_noise?: string
          family?: string
          fp_budget_per_30d?: number
          label?: string
          needs_recalibration?: boolean
          ord?: number
          plain?: string
          recalibrated_at?: string | null
          structural_note?: string | null
          tolerance_note?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      reconciliations: {
        Row: {
          check_id: string
          checked_at: string
          divergence_pct: number | null
          for_date: string
          id: string
          note: string | null
          primary_source: string
          primary_value: number | null
          verdict: string
          witness_source: string
          witness_value: number | null
        }
        Insert: {
          check_id: string
          checked_at?: string
          divergence_pct?: number | null
          for_date: string
          id?: string
          note?: string | null
          primary_source: string
          primary_value?: number | null
          verdict: string
          witness_source: string
          witness_value?: number | null
        }
        Update: {
          check_id?: string
          checked_at?: string
          divergence_pct?: number | null
          for_date?: string
          id?: string
          note?: string | null
          primary_source?: string
          primary_value?: number | null
          verdict?: string
          witness_source?: string
          witness_value?: number | null
        }
        Relationships: []
      }
      recording_transcript_cues: {
        Row: {
          cue_index: number
          end_ms: number
          id: number
          speaker: string | null
          start_ms: number
          text: string
          transcript_id: string
        }
        Insert: {
          cue_index: number
          end_ms: number
          id?: number
          speaker?: string | null
          start_ms: number
          text: string
          transcript_id: string
        }
        Update: {
          cue_index?: number
          end_ms?: number
          id?: number
          speaker?: string | null
          start_ms?: number
          text?: string
          transcript_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recording_transcript_cues_transcript_id_fkey"
            columns: ["transcript_id"]
            isOneToOne: false
            referencedRelation: "recording_transcripts"
            referencedColumns: ["id"]
          },
        ]
      }
      recording_transcripts: {
        Row: {
          captured_at: string
          cue_count: number
          duration_ms: number | null
          full_text: string
          id: string
          language: string | null
          recording_id: string
          session_ref: string
          source_type: string
          storage_path: string | null
          updated_at: string
        }
        Insert: {
          captured_at?: string
          cue_count?: number
          duration_ms?: number | null
          full_text?: string
          id?: string
          language?: string | null
          recording_id: string
          session_ref: string
          source_type: string
          storage_path?: string | null
          updated_at?: string
        }
        Update: {
          captured_at?: string
          cue_count?: number
          duration_ms?: number | null
          full_text?: string
          id?: string
          language?: string | null
          recording_id?: string
          session_ref?: string
          source_type?: string
          storage_path?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      regime_events: {
        Row: {
          agency_code: string | null
          boundary_date: string
          confirmed_by: string
          created_at: string
          enabled: boolean
          event_key: string
          evidence: Json
          kind: string
          label: string
          plain: string
          updated_at: string
        }
        Insert: {
          agency_code?: string | null
          boundary_date: string
          confirmed_by: string
          created_at?: string
          enabled?: boolean
          event_key: string
          evidence?: Json
          kind: string
          label: string
          plain: string
          updated_at?: string
        }
        Update: {
          agency_code?: string | null
          boundary_date?: string
          confirmed_by?: string
          created_at?: string
          enabled?: boolean
          event_key?: string
          evidence?: Json
          kind?: string
          label?: string
          plain?: string
          updated_at?: string
        }
        Relationships: []
      }
      review_items: {
        Row: {
          created_at: string
          detail: string | null
          evidence: Json
          id: string
          kind: string
          ref_id: string | null
          resolved_at: string | null
          resolved_note: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          detail?: string | null
          evidence?: Json
          id?: string
          kind: string
          ref_id?: string | null
          resolved_at?: string | null
          resolved_note?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          detail?: string | null
          evidence?: Json
          id?: string
          kind?: string
          ref_id?: string | null
          resolved_at?: string | null
          resolved_note?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      rule_changes: {
        Row: {
          affects: string[]
          confirmed_by: string
          created_at: string
          evidence: Json
          id: string
          new_rule: string
          old_rule: string | null
          reason: string
          rule_key: string
          what_changed: string
        }
        Insert: {
          affects?: string[]
          confirmed_by: string
          created_at?: string
          evidence?: Json
          id?: string
          new_rule: string
          old_rule?: string | null
          reason: string
          rule_key: string
          what_changed: string
        }
        Update: {
          affects?: string[]
          confirmed_by?: string
          created_at?: string
          evidence?: Json
          id?: string
          new_rule?: string
          old_rule?: string | null
          reason?: string
          rule_key?: string
          what_changed?: string
        }
        Relationships: []
      }
      sale_attribution: {
        Row: {
          business_date: string | null
          cash: number
          channel: string
          computed_at: string
          confidence: string
          counts_as_sale: boolean
          email_key: string | null
          is_new_sale: boolean
          layer: string | null
          month: string
          row_hash: string
          source: string
          tool: string | null
        }
        Insert: {
          business_date?: string | null
          cash?: number
          channel: string
          computed_at?: string
          confidence: string
          counts_as_sale?: boolean
          email_key?: string | null
          is_new_sale?: boolean
          layer?: string | null
          month: string
          row_hash: string
          source: string
          tool?: string | null
        }
        Update: {
          business_date?: string | null
          cash?: number
          channel?: string
          computed_at?: string
          confidence?: string
          counts_as_sale?: boolean
          email_key?: string | null
          is_new_sale?: boolean
          layer?: string | null
          month?: string
          row_hash?: string
          source?: string
          tool?: string | null
        }
        Relationships: []
      }
      script_link_proposals: {
        Row: {
          ad_entity_id: string
          basis: string
          confidence: number
          decided_at: string | null
          proposed_at: string
          script_id: string
          status: string
        }
        Insert: {
          ad_entity_id: string
          basis: string
          confidence: number
          decided_at?: string | null
          proposed_at?: string
          script_id: string
          status?: string
        }
        Update: {
          ad_entity_id?: string
          basis?: string
          confidence?: number
          decided_at?: string | null
          proposed_at?: string
          script_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "script_link_proposals_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "creative_scripts"
            referencedColumns: ["id"]
          },
        ]
      }
      script_markers: {
        Row: {
          at_ms: number
          at_webinar_ms: number | null
          created_at: string
          id: string
          is_offer_moment: boolean
          label: string
          marker_key: string
          note: string | null
          source: string
          transcript_id: string
          updated_at: string
        }
        Insert: {
          at_ms: number
          at_webinar_ms?: number | null
          created_at?: string
          id?: string
          is_offer_moment?: boolean
          label: string
          marker_key: string
          note?: string | null
          source?: string
          transcript_id: string
          updated_at?: string
        }
        Update: {
          at_ms?: number
          at_webinar_ms?: number | null
          created_at?: string
          id?: string
          is_offer_moment?: boolean
          label?: string
          marker_key?: string
          note?: string | null
          source?: string
          transcript_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "script_markers_transcript_id_fkey"
            columns: ["transcript_id"]
            isOneToOne: false
            referencedRelation: "script_marker_clock"
            referencedColumns: ["transcript_id"]
          },
          {
            foreignKeyName: "script_markers_transcript_id_fkey"
            columns: ["transcript_id"]
            isOneToOne: false
            referencedRelation: "webinar_transcripts"
            referencedColumns: ["id"]
          },
        ]
      }
      script_tags: {
        Row: {
          confirmed: boolean
          created_at: string
          cta_style: string
          emotional_register: string
          first_8s_hook: string | null
          hook_mechanism: string
          model: string | null
          pain: string
          persona: string
          persona_secondary: string | null
          promise: string
          script_id: string
          spiritual_scale: string
          structure: string
          tagged_by: string
          updated_at: string
        }
        Insert: {
          confirmed?: boolean
          created_at?: string
          cta_style: string
          emotional_register: string
          first_8s_hook?: string | null
          hook_mechanism: string
          model?: string | null
          pain: string
          persona: string
          persona_secondary?: string | null
          promise: string
          script_id: string
          spiritual_scale: string
          structure: string
          tagged_by?: string
          updated_at?: string
        }
        Update: {
          confirmed?: boolean
          created_at?: string
          cta_style?: string
          emotional_register?: string
          first_8s_hook?: string | null
          hook_mechanism?: string
          model?: string | null
          pain?: string
          persona?: string
          persona_secondary?: string | null
          promise?: string
          script_id?: string
          spiritual_scale?: string
          structure?: string
          tagged_by?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "script_tags_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: true
            referencedRelation: "creative_scripts"
            referencedColumns: ["id"]
          },
        ]
      }
      source_dictionary: {
        Row: {
          channel_group: string
          confidence: string
          created_at: string
          display_name: string
          id: string
          is_acquisition: boolean
          is_paid: boolean
          layer: string
          match_kind: string
          note: string | null
          raw_value: string
          updated_at: string
          valid_from: string | null
          valid_to: string | null
        }
        Insert: {
          channel_group: string
          confidence?: string
          created_at?: string
          display_name: string
          id?: string
          is_acquisition?: boolean
          is_paid?: boolean
          layer: string
          match_kind?: string
          note?: string | null
          raw_value: string
          updated_at?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Update: {
          channel_group?: string
          confidence?: string
          created_at?: string
          display_name?: string
          id?: string
          is_acquisition?: boolean
          is_paid?: boolean
          layer?: string
          match_kind?: string
          note?: string | null
          raw_value?: string
          updated_at?: string
          valid_from?: string | null
          valid_to?: string | null
        }
        Relationships: []
      }
      sync_retry_log: {
        Row: {
          at: string
          attempt: number
          id: string
          reason: string | null
          source: string
          step: string
        }
        Insert: {
          at?: string
          attempt: number
          id?: string
          reason?: string | null
          source: string
          step: string
        }
        Update: {
          at?: string
          attempt?: number
          id?: string
          reason?: string | null
          source?: string
          step?: string
        }
        Relationships: []
      }
      sync_runs: {
        Row: {
          error: string | null
          error_detail: string | null
          expected_rows: number | null
          finished_at: string | null
          id: string
          rows_written: number
          source: string | null
          started_at: string
          status: string | null
          yield_note: string | null
          yield_verdict: string | null
        }
        Insert: {
          error?: string | null
          error_detail?: string | null
          expected_rows?: number | null
          finished_at?: string | null
          id?: string
          rows_written?: number
          source?: string | null
          started_at?: string
          status?: string | null
          yield_note?: string | null
          yield_verdict?: string | null
        }
        Update: {
          error?: string | null
          error_detail?: string | null
          expected_rows?: number | null
          finished_at?: string | null
          id?: string
          rows_written?: number
          source?: string | null
          started_at?: string
          status?: string | null
          yield_note?: string | null
          yield_verdict?: string | null
        }
        Relationships: []
      }
      sync_source_config: {
        Row: {
          cadence_hours: number
          is_critical: boolean
          label: string
          note: string | null
          source: string
        }
        Insert: {
          cadence_hours?: number
          is_critical?: boolean
          label: string
          note?: string | null
          source: string
        }
        Update: {
          cadence_hours?: number
          is_critical?: boolean
          label?: string
          note?: string | null
          source?: string
        }
        Relationships: []
      }
      sync_yield_rules: {
        Row: {
          lookback_days: number
          max_factor: number
          min_factor: number
          note: string | null
          source: string
          updated_at: string
          zero_policy: string
        }
        Insert: {
          lookback_days?: number
          max_factor?: number
          min_factor?: number
          note?: string | null
          source: string
          updated_at?: string
          zero_policy?: string
        }
        Update: {
          lookback_days?: number
          max_factor?: number
          min_factor?: number
          note?: string | null
          source?: string
          updated_at?: string
          zero_policy?: string
        }
        Relationships: []
      }
      team_source_register: {
        Row: {
          alt_email_key: string | null
          alt_email_raw: string | null
          email_key: string | null
          email_raw: string | null
          entry_date: string
          loaded_at: string
          match_key: string
          notes: string | null
          phone10: string | null
          student_name: string | null
          team_source_detail: string | null
          team_source_raw: string | null
          webinar_attended: string | null
        }
        Insert: {
          alt_email_key?: string | null
          alt_email_raw?: string | null
          email_key?: string | null
          email_raw?: string | null
          entry_date: string
          loaded_at?: string
          match_key: string
          notes?: string | null
          phone10?: string | null
          student_name?: string | null
          team_source_detail?: string | null
          team_source_raw?: string | null
          webinar_attended?: string | null
        }
        Update: {
          alt_email_key?: string | null
          alt_email_raw?: string | null
          email_key?: string | null
          email_raw?: string | null
          entry_date?: string
          loaded_at?: string
          match_key?: string
          notes?: string | null
          phone10?: string | null
          student_name?: string | null
          team_source_detail?: string | null
          team_source_raw?: string | null
          webinar_attended?: string | null
        }
        Relationships: []
      }
      tm_enrolments: {
        Row: {
          affiliate_user: string | null
          amount_via_tagmango: number
          business_date: string | null
          buyer_email: string | null
          buyer_phone: string | null
          coupon_code: string | null
          enrolled_at: string | null
          is_coupon: boolean
          mango_id: string | null
          person_key: string
          raw: Json | null
          status: string | null
          subscription_id: string
          synced_at: string
        }
        Insert: {
          affiliate_user?: string | null
          amount_via_tagmango?: number
          business_date?: string | null
          buyer_email?: string | null
          buyer_phone?: string | null
          coupon_code?: string | null
          enrolled_at?: string | null
          is_coupon?: boolean
          mango_id?: string | null
          person_key: string
          raw?: Json | null
          status?: string | null
          subscription_id: string
          synced_at?: string
        }
        Update: {
          affiliate_user?: string | null
          amount_via_tagmango?: number
          business_date?: string | null
          buyer_email?: string | null
          buyer_phone?: string | null
          coupon_code?: string | null
          enrolled_at?: string | null
          is_coupon?: boolean
          mango_id?: string | null
          person_key?: string
          raw?: Json | null
          status?: string | null
          subscription_id?: string
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tm_enrolments_mango_id_fkey"
            columns: ["mango_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["mango_id"]
          },
        ]
      }
      tm_payments: {
        Row: {
          affiliate_commission: number | null
          affiliate_user: string | null
          amount_gross: number
          amount_inr: number | null
          amount_net: number | null
          business_date: string | null
          buyer_email: string | null
          buyer_phone: string | null
          coupon_code: string | null
          currency: string | null
          discount_inr: number | null
          exchange_rate: number | null
          fx_basis: string | null
          list_price_inr: number | null
          mango_id: string | null
          paid_at: string | null
          payment_id: string
          raw: Json | null
          sale_status: string | null
          status: string | null
          synced_at: string
        }
        Insert: {
          affiliate_commission?: number | null
          affiliate_user?: string | null
          amount_gross?: number
          amount_inr?: number | null
          amount_net?: number | null
          business_date?: string | null
          buyer_email?: string | null
          buyer_phone?: string | null
          coupon_code?: string | null
          currency?: string | null
          discount_inr?: number | null
          exchange_rate?: number | null
          fx_basis?: string | null
          list_price_inr?: number | null
          mango_id?: string | null
          paid_at?: string | null
          payment_id: string
          raw?: Json | null
          sale_status?: string | null
          status?: string | null
          synced_at?: string
        }
        Update: {
          affiliate_commission?: number | null
          affiliate_user?: string | null
          amount_gross?: number
          amount_inr?: number | null
          amount_net?: number | null
          business_date?: string | null
          buyer_email?: string | null
          buyer_phone?: string | null
          coupon_code?: string | null
          currency?: string | null
          discount_inr?: number | null
          exchange_rate?: number | null
          fx_basis?: string | null
          list_price_inr?: number | null
          mango_id?: string | null
          paid_at?: string | null
          payment_id?: string
          raw?: Json | null
          sale_status?: string | null
          status?: string | null
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tm_payments_mango_id_fkey"
            columns: ["mango_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["mango_id"]
          },
        ]
      }
      tm_sales: {
        Row: {
          amount_via_ledger: number | null
          amount_via_tagmango: number
          business_date: string | null
          coupon_code: string | null
          enrolment_count: number
          expected_gross: number
          first_mango_id: string | null
          first_payment_at: string | null
          gross_collected: number
          is_coupon: boolean
          is_fully_paid: boolean
          payment_count: number
          payment_route: string | null
          person_key: string
          revenue_source: string | null
          revenue_status: string | null
          sale_id: string
          updated_at: string
        }
        Insert: {
          amount_via_ledger?: number | null
          amount_via_tagmango?: number
          business_date?: string | null
          coupon_code?: string | null
          enrolment_count?: number
          expected_gross?: number
          first_mango_id?: string | null
          first_payment_at?: string | null
          gross_collected?: number
          is_coupon?: boolean
          is_fully_paid?: boolean
          payment_count?: number
          payment_route?: string | null
          person_key: string
          revenue_source?: string | null
          revenue_status?: string | null
          sale_id?: string
          updated_at?: string
        }
        Update: {
          amount_via_ledger?: number | null
          amount_via_tagmango?: number
          business_date?: string | null
          coupon_code?: string | null
          enrolment_count?: number
          expected_gross?: number
          first_mango_id?: string | null
          first_payment_at?: string | null
          gross_collected?: number
          is_coupon?: boolean
          is_fully_paid?: boolean
          payment_count?: number
          payment_route?: string | null
          person_key?: string
          revenue_source?: string | null
          revenue_status?: string | null
          sale_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      utm_agency_map: {
        Row: {
          agency_code: string
          label: string | null
          note: string | null
          suffix: string
          updated_at: string
        }
        Insert: {
          agency_code: string
          label?: string | null
          note?: string | null
          suffix: string
          updated_at?: string
        }
        Update: {
          agency_code?: string
          label?: string | null
          note?: string | null
          suffix?: string
          updated_at?: string
        }
        Relationships: []
      }
      utm_source_map: {
        Row: {
          is_paid: boolean
          note: string | null
          platform: string
          raw: string
          updated_at: string
        }
        Insert: {
          is_paid?: boolean
          note?: string | null
          platform?: string
          raw: string
          updated_at?: string
        }
        Update: {
          is_paid?: boolean
          note?: string | null
          platform?: string
          raw?: string
          updated_at?: string
        }
        Relationships: []
      }
      verdict_history: {
        Row: {
          baseline: number | null
          created_at: string
          date: string
          direction: string | null
          metric_id: string
          position: number
          rank: number
          rupees: number
          value: number | null
          z: number
        }
        Insert: {
          baseline?: number | null
          created_at?: string
          date: string
          direction?: string | null
          metric_id: string
          position: number
          rank?: number
          rupees?: number
          value?: number | null
          z: number
        }
        Update: {
          baseline?: number | null
          created_at?: string
          date?: string
          direction?: string | null
          metric_id?: string
          position?: number
          rank?: number
          rupees?: number
          value?: number | null
          z?: number
        }
        Relationships: []
      }
      webinar_slot_schedule: {
        Row: {
          confirmed_by: string
          effective_from: string
          note: string | null
          slots: string
          updated_at: string
        }
        Insert: {
          confirmed_by: string
          effective_from: string
          note?: string | null
          slots: string
          updated_at?: string
        }
        Update: {
          confirmed_by?: string
          effective_from?: string
          note?: string | null
          slots?: string
          updated_at?: string
        }
        Relationships: []
      }
      webinar_transcript_lines: {
        Row: {
          end_ms: number
          id: number
          is_music: boolean
          line_no: number
          speaker: string | null
          start_ms: number
          text: string
          transcript_id: string
        }
        Insert: {
          end_ms: number
          id?: number
          is_music?: boolean
          line_no: number
          speaker?: string | null
          start_ms: number
          text: string
          transcript_id: string
        }
        Update: {
          end_ms?: number
          id?: number
          is_music?: boolean
          line_no?: number
          speaker?: string | null
          start_ms?: number
          text?: string
          transcript_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "webinar_transcript_lines_transcript_id_fkey"
            columns: ["transcript_id"]
            isOneToOne: false
            referencedRelation: "script_marker_clock"
            referencedColumns: ["transcript_id"]
          },
          {
            foreignKeyName: "webinar_transcript_lines_transcript_id_fkey"
            columns: ["transcript_id"]
            isOneToOne: false
            referencedRelation: "webinar_transcripts"
            referencedColumns: ["id"]
          },
        ]
      }
      webinar_transcripts: {
        Row: {
          actual_start_evidence: string | null
          actual_start_offset_ms: number | null
          coverage: string
          covers_end_ms: number | null
          covers_start_ms: number | null
          created_at: string
          effective_from: string
          file_name: string | null
          id: string
          is_canonical: boolean
          language: string | null
          line_count: number
          note: string | null
          script_version: number
          segment_no: number
          session_match_hint: string
          session_ref: string | null
          source: string
          updated_at: string
          vtt_raw: string
        }
        Insert: {
          actual_start_evidence?: string | null
          actual_start_offset_ms?: number | null
          coverage?: string
          covers_end_ms?: number | null
          covers_start_ms?: number | null
          created_at?: string
          effective_from: string
          file_name?: string | null
          id?: string
          is_canonical?: boolean
          language?: string | null
          line_count?: number
          note?: string | null
          script_version?: number
          segment_no?: number
          session_match_hint: string
          session_ref?: string | null
          source?: string
          updated_at?: string
          vtt_raw: string
        }
        Update: {
          actual_start_evidence?: string | null
          actual_start_offset_ms?: number | null
          coverage?: string
          covers_end_ms?: number | null
          covers_start_ms?: number | null
          created_at?: string
          effective_from?: string
          file_name?: string | null
          id?: string
          is_canonical?: boolean
          language?: string | null
          line_count?: number
          note?: string | null
          script_version?: number
          segment_no?: number
          session_match_hint?: string
          session_ref?: string | null
          source?: string
          updated_at?: string
          vtt_raw?: string
        }
        Relationships: [
          {
            foreignKeyName: "webinar_transcripts_session_fk"
            columns: ["session_ref"]
            isOneToOne: false
            referencedRelation: "session_script_coverage"
            referencedColumns: ["session_uuid"]
          },
          {
            foreignKeyName: "webinar_transcripts_session_fk"
            columns: ["session_ref"]
            isOneToOne: false
            referencedRelation: "zoom_sessions"
            referencedColumns: ["session_uuid"]
          },
        ]
      }
      weekly_email_log: {
        Row: {
          attempts: number
          body_text: string | null
          business_date: string
          last_error: string | null
          recipients: string[] | null
          sent_at: string | null
          status: string
          subject: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          body_text?: string | null
          business_date: string
          last_error?: string | null
          recipients?: string[] | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          body_text?: string | null
          business_date?: string
          last_error?: string | null
          recipients?: string[] | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      zoom_ignored_sessions: {
        Row: {
          business_date: string | null
          host_email: string | null
          seen_at: string
          session_type: string | null
          session_uuid: string
          start_time: string | null
          topic: string | null
          zoom_id: string | null
        }
        Insert: {
          business_date?: string | null
          host_email?: string | null
          seen_at?: string
          session_type?: string | null
          session_uuid: string
          start_time?: string | null
          topic?: string | null
          zoom_id?: string | null
        }
        Update: {
          business_date?: string | null
          host_email?: string | null
          seen_at?: string
          session_type?: string | null
          session_uuid?: string
          start_time?: string | null
          topic?: string | null
          zoom_id?: string | null
        }
        Relationships: []
      }
      zoom_participants: {
        Row: {
          duration_sec: number | null
          email: string | null
          id: string
          invalid_reason: string | null
          is_valid: boolean
          join_time: string | null
          leave_time: string | null
          name: string | null
          participant_id: string | null
          session_uuid: string | null
        }
        Insert: {
          duration_sec?: number | null
          email?: string | null
          id?: string
          invalid_reason?: string | null
          is_valid?: boolean
          join_time?: string | null
          leave_time?: string | null
          name?: string | null
          participant_id?: string | null
          session_uuid?: string | null
        }
        Update: {
          duration_sec?: number | null
          email?: string | null
          id?: string
          invalid_reason?: string | null
          is_valid?: boolean
          join_time?: string | null
          leave_time?: string | null
          name?: string | null
          participant_id?: string | null
          session_uuid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "zoom_participants_session_uuid_fkey"
            columns: ["session_uuid"]
            isOneToOne: false
            referencedRelation: "session_script_coverage"
            referencedColumns: ["session_uuid"]
          },
          {
            foreignKeyName: "zoom_participants_session_uuid_fkey"
            columns: ["session_uuid"]
            isOneToOne: false
            referencedRelation: "zoom_sessions"
            referencedColumns: ["session_uuid"]
          },
        ]
      }
      zoom_recordings: {
        Row: {
          created_at: string
          download_url: string | null
          file_extension: string | null
          file_size: number | null
          id: string
          note: string | null
          play_url: string | null
          recorded_at: string | null
          recording_end: string | null
          recording_id: string | null
          recording_start: string | null
          recording_type: string
          session_ref: string
          status: string
          storage_path: string | null
          updated_at: string
          url_expires_at: string | null
        }
        Insert: {
          created_at?: string
          download_url?: string | null
          file_extension?: string | null
          file_size?: number | null
          id?: string
          note?: string | null
          play_url?: string | null
          recorded_at?: string | null
          recording_end?: string | null
          recording_id?: string | null
          recording_start?: string | null
          recording_type: string
          session_ref: string
          status?: string
          storage_path?: string | null
          updated_at?: string
          url_expires_at?: string | null
        }
        Update: {
          created_at?: string
          download_url?: string | null
          file_extension?: string | null
          file_size?: number | null
          id?: string
          note?: string | null
          play_url?: string | null
          recorded_at?: string | null
          recording_end?: string | null
          recording_id?: string | null
          recording_start?: string | null
          recording_type?: string
          session_ref?: string
          status?: string
          storage_path?: string | null
          updated_at?: string
          url_expires_at?: string | null
        }
        Relationships: []
      }
      zoom_sessions: {
        Row: {
          business_date: string | null
          duration_min: number | null
          end_time: string | null
          event_key: string | null
          host_email: string | null
          host_id: string | null
          participants_note: string | null
          participants_status: string | null
          session_format: string | null
          session_role: string
          session_type: string
          session_uuid: string
          start_time: string | null
          synced_at: string
          topic: string | null
          topic_date: string | null
          total_attendees: number | null
          total_registrants: number | null
          zoom_id: string | null
        }
        Insert: {
          business_date?: string | null
          duration_min?: number | null
          end_time?: string | null
          event_key?: string | null
          host_email?: string | null
          host_id?: string | null
          participants_note?: string | null
          participants_status?: string | null
          session_format?: string | null
          session_role?: string
          session_type: string
          session_uuid: string
          start_time?: string | null
          synced_at?: string
          topic?: string | null
          topic_date?: string | null
          total_attendees?: number | null
          total_registrants?: number | null
          zoom_id?: string | null
        }
        Update: {
          business_date?: string | null
          duration_min?: number | null
          end_time?: string | null
          event_key?: string | null
          host_email?: string | null
          host_id?: string | null
          participants_note?: string | null
          participants_status?: string | null
          session_format?: string | null
          session_role?: string
          session_type?: string
          session_uuid?: string
          start_time?: string | null
          synced_at?: string
          topic?: string | null
          topic_date?: string | null
          total_attendees?: number | null
          total_registrants?: number | null
          zoom_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      buyer_lead_link: {
        Row: {
          email_key: string | null
          lead_email_key: string | null
          match_basis: string | null
        }
        Relationships: []
      }
      buyer_phone_candidates: {
        Row: {
          email_key: string | null
          lead_email_key: string | null
          phone_key: string | null
        }
        Relationships: []
      }
      buyer_phone_conflicts: {
        Row: {
          candidates: number | null
          email_key: string | null
          lead_emails: string | null
        }
        Relationships: []
      }
      buyer_phones: {
        Row: {
          email_key: string | null
          phone_key: string | null
        }
        Relationships: []
      }
      l1_charged_payments: {
        Row: {
          amount_gross: number | null
          amount_inr: number | null
          business_date: string | null
          coupon_code: string | null
          currency: string | null
          discount_given: number | null
          email_key: string | null
          exchange_rate: number | null
          expected_price: number | null
          is_overseas: boolean | null
          list_price: number | null
          on_promotion: boolean | null
          payment_id: string | null
          promotion_name: string | null
        }
        Relationships: []
      }
      lead_attribution: {
        Row: {
          ad_account_id: string | null
          ad_id: string | null
          agency_code: string | null
          campaign_id: string | null
          captured_at: string | null
          email_key: string | null
          is_import: boolean | null
          is_paid: boolean | null
          platform: string | null
          utm_campaign: string | null
          utm_medium: string | null
          utm_source: string | null
        }
        Relationships: []
      }
      lead_attribution_mv: {
        Row: {
          ad_account_id: string | null
          ad_id: string | null
          agency_code: string | null
          campaign_id: string | null
          captured_at: string | null
          email_key: string | null
          is_import: boolean | null
          is_paid: boolean | null
          platform: string | null
          utm_campaign: string | null
          utm_medium: string | null
          utm_source: string | null
        }
        Relationships: []
      }
      script_marker_clock: {
        Row: {
          at_ms: number | null
          at_promised_ms: number | null
          at_webinar_ms: number | null
          effective_from: string | null
          is_offer_moment: boolean | null
          label: string | null
          marker_key: string | null
          minute_from_promised_start: number | null
          transcript_id: string | null
        }
        Relationships: []
      }
      session_script_coverage: {
        Row: {
          business_date: string | null
          has_script: boolean | null
          session_format: string | null
          session_role: string | null
          session_uuid: string | null
          transcript_id: string | null
        }
        Insert: {
          business_date?: string | null
          has_script?: never
          session_format?: string | null
          session_role?: string | null
          session_uuid?: string | null
          transcript_id?: never
        }
        Update: {
          business_date?: string | null
          has_script?: never
          session_format?: string | null
          session_role?: string | null
          session_uuid?: string | null
          transcript_id?: never
        }
        Relationships: []
      }
      sync_health: {
        Row: {
          cadence_hours: number | null
          consecutive_failures: number | null
          hours_since_success: number | null
          is_critical: boolean | null
          label: string | null
          last_error: string | null
          last_run: string | null
          last_success: string | null
          note: string | null
          source: string | null
          status: string | null
        }
        Relationships: []
      }
      zoom_attendance: {
        Row: {
          email: string | null
          first_join: string | null
          last_leave: string | null
          name: string | null
          person_key: string | null
          segments: number | null
          session_uuid: string | null
          total_duration_sec: number | null
        }
        Relationships: [
          {
            foreignKeyName: "zoom_participants_session_uuid_fkey"
            columns: ["session_uuid"]
            isOneToOne: false
            referencedRelation: "session_script_coverage"
            referencedColumns: ["session_uuid"]
          },
          {
            foreignKeyName: "zoom_participants_session_uuid_fkey"
            columns: ["session_uuid"]
            isOneToOne: false
            referencedRelation: "zoom_sessions"
            referencedColumns: ["session_uuid"]
          },
        ]
      }
    }
    Functions: {
      account_agency_at: {
        Args: { p_account_id: string; p_date: string }
        Returns: string
      }
      account_matured_sale_rate: {
        Args: { p_end: string; p_start: string }
        Returns: {
          matured_leads: number
          matured_sales: number
          sale_rate: number
        }[]
      }
      account_month_rollup: {
        Args: { p_end: string; p_start: string }
        Returns: {
          account_id: string
          account_role: string
          agency_code: string
          days_missing_leads: number
          days_with_data: number
          has_data: boolean
          impressions: number
          is_active: boolean
          landing_page_views: number
          lead_tracking_status: string
          leads: number
          link_clicks: number
          name: string
          purchases: number
          spend: number
        }[]
      }
      account_tracking_evidence: {
        Args: { p_days?: number }
        Returns: {
          account_id: string
          matched_by_ad: number
          matched_by_campaign: number
          matched_total: number
          meta_leads: number
          name: string
          pct: number
          spend: number
          status_by_evidence: string
          status_now: string
        }[]
      }
      ad_field_meta_label: { Args: { p_campaign: string }; Returns: string }
      ad_performance: {
        Args: { p_days?: number }
        Returns: {
          account_id: string
          ad_name: string
          agency_code: string
          cost_per_reg: number
          cost_per_sale: number
          entity_id: string
          permalink_url: string
          registrations: number
          sales: number
          spend: number
          thumbnail_url: string
        }[]
      }
      agency_channel_code: { Args: { p_channel: string }; Returns: string }
      agency_code_for: { Args: { p_utm_source: string }; Returns: string }
      agency_golden_value: {
        Args: { p_end: string; p_metric_id: string; p_start: string }
        Returns: number
      }
      agency_spend_synced: { Args: { p_code: string }; Returns: boolean }
      analyst_decomposition: { Args: { p_date: string }; Returns: Json }
      analyze_tables: { Args: { p_tables: string[] }; Returns: string[] }
      apply_first_touch_source: { Args: never; Returns: number }
      ask_run_sql: { Args: { p_limit?: number; p_sql: string }; Returns: Json }
      begin_ledger_rebuild: { Args: never; Returns: undefined }
      business_date: { Args: { p_ts: string }; Returns: string }
      buyer_paid_team: { Args: { p_email_key: string }; Returns: string }
      canonical_transcript_at: { Args: { _d: string }; Returns: string }
      channel_is_paid_media: { Args: { p_channel: string }; Returns: boolean }
      channel_team_code: { Args: { p_channel: string }; Returns: string }
      channel_traced_registrations: {
        Args: { p_date: string }
        Returns: {
          channel: string
          first_seen: string
          registrations: number
          traced: number
        }[]
      }
      check_ad_account_handover: { Args: never; Returns: Json }
      close_finished_months: { Args: never; Returns: Json }
      cohort_backend_return: {
        Args: { p_from?: string; p_to?: string }
        Returns: {
          back_d180: number
          back_d30: number
          back_d365: number
          back_d60: number
          back_d90: number
          back_d90_all: number
          back_life: number
          back_life_all: number
          breakeven_month: number
          buyers: number
          cohort_month: string
          coverage_pct: number
          front_d180: number
          front_d30: number
          front_d365: number
          front_d60: number
          front_d90: number
          front_d90_all: number
          front_life: number
          front_life_all: number
          matched_buyers: number
          maturing: boolean
          months_elapsed: number
          paid_buyers: number
          per_buyer_life: number
          per_buyer_life_all: number
          per_buyer_life_paid: number
          roas_d180: number
          roas_d30: number
          roas_d365: number
          roas_d90: number
          roas_d90_all: number
          roas_life: number
          roas_life_all: number
          spend: number
          spend_basis: string
          total_life: number
        }[]
      }
      cohort_golden_d90: {
        Args: { p_end: string; p_start: string }
        Returns: number
      }
      commit_ledger_rebuild: {
        Args: { p_allow_shrink?: boolean }
        Returns: Json
      }
      concept_ledger: {
        Args: { p_end: string; p_start: string }
        Returns: {
          ads_mapped: number
          attendees: number
          attendees_60: number
          concept_id: string
          iterations: number
          matched_leads: number
          matured_leads: number
          matured_sales: number
          name: string
          opened_at: string
          pain: string
          persona: string
          promise: string
          reference_cpl: number
          spend: number
          state: string
          state_changed_at: string
        }[]
      }
      concept_weekly_stats: {
        Args: { p_end: string }
        Returns: {
          attendees_60_7d: number
          concept_id: string
          cpl_7d: number
          cpl_prev7: number
          frequency_7d: number
          leads_7d: number
          leads_prev7: number
          rate_60_7d: number
          rate_60_prev7: number
          reference_cpl: number
          spend_7d: number
          spend_prev7: number
          state: string
        }[]
      }
      contract_drift: { Args: never; Returns: Json }
      contract_eval: {
        Args: { p_end: string; p_metric_id: string; p_start: string }
        Returns: Json
      }
      creative_ad_rows: {
        Args: { p_end: string; p_script?: string; p_start: string }
        Returns: {
          ad_name: string
          confidence: number
          creative_body: string
          creative_title: string
          entity_id: string
          impressions: number
          link_clicks: number
          mapped_by: string
          meta_leads: number
          script_code: string
          spend: number
          thumbnail_url: string
          tracked_leads: number
        }[]
      }
      creative_money_coverage: {
        Args: { p_days?: number }
        Returns: {
          ads_mapped: number
          ads_spent: number
          spend_mapped: number
          spend_total: number
        }[]
      }
      creative_registry: {
        Args: { p_end: string; p_start: string }
        Returns: {
          ads_mapped: number
          attendees: number
          attendees_60: number
          impressions: number
          link_clicks: number
          low_conf_ads: number
          meta_leads: number
          script_code: string
          script_id: string
          spend: number
          title: string
          tracked_leads: number
        }[]
      }
      creative_retry_targets: {
        Args: { p_days?: number }
        Returns: {
          account_id: string
          entity_id: string
        }[]
      }
      creative_text_coverage: {
        Args: never
        Returns: {
          ads_active: number
          ads_total: number
          fetch_failed: number
          never_fetched: number
          with_body: number
          with_title: number
        }[]
      }
      creative_unmapped_ads: {
        Args: { p_days?: number }
        Returns: {
          account_id: string
          ad_name: string
          creative_body: string
          creative_title: string
          entity_id: string
          leads: number
          spend: number
          thumbnail_url: string
        }[]
      }
      credential_alert_rows: {
        Args: never
        Returns: {
          days_left: number
          expires_at: string
          key: string
          label: string
          level: string
          sentence: string
        }[]
      }
      cron_post: { Args: { p_jobname: string }; Returns: number }
      daily_coverage: {
        Args: { p_end: string; p_start: string }
        Returns: {
          date: string
          leads_rows: number
          ledger_rows: number
          meta_rows: number
          zoom_rows: number
        }[]
      }
      daily_email_figures: { Args: { p_date: string }; Returns: Json }
      daily_email_month_figures: { Args: { p_date: string }; Returns: Json }
      daily_sale_amount_groups: {
        Args: { p_date: string }
        Returns: {
          amount: number
          counted: number
          email_key: string
          payer_name: string
          platform_dates: string[]
          platform_payments: number
          sheet_rows: number
        }[]
      }
      daily_sale_sources: {
        Args: { p_date: string }
        Returns: {
          cash: number
          channel: string
          email_key: string
          first_reg: string
          has_lead: boolean
          paid_direct: boolean
          payer_name: string
          rows_count: number
          source: string
        }[]
      }
      daily_spend_series: {
        Args: { p_end: string; p_start: string }
        Returns: {
          date: string
          leads: number
          measured_leads: number
          measured_spend: number
          spend: number
        }[]
      }
      demo_persona_audit: {
        Args: { p_end: string; p_start: string }
        Returns: {
          age_bucket: string
          attendees_60: number
          impressions: number
          leads: number
          link_clicks: number
          persona: string
          spend: number
        }[]
      }
      deploy_status: {
        Args: never
        Returns: {
          deploy_ref: string
          deployed_at: string
          goldens_fail: number
          goldens_pass: number
          invariants_diverged: number
          note: string
          verified_at: string
          verify_status: string
        }[]
      }
      dict_match: {
        Args: { p_layer: string; p_on: string; p_value: string }
        Returns: {
          channel_group: string
          confidence: string
          display_name: string
          is_acquisition: boolean
          is_paid: boolean
        }[]
      }
      enforce_watchdog_budgets: { Args: never; Returns: Json }
      entity_grain_counts: {
        Args: { p_end: string; p_start: string }
        Returns: {
          entities: number
          level: string
          rows_n: number
          spend: number
        }[]
      }
      entity_rollup: {
        Args: { p_end: string; p_level: string; p_start: string }
        Returns: {
          account_id: string
          account_name: string
          days_missing_leads: number
          days_with_data: number
          entity_id: string
          entity_name: string
          impressions: number
          landing_page_views: number
          lead_tracking_status: string
          leads: number
          link_clicks: number
          purchases: number
          spend: number
          status: string
        }[]
      }
      feed_day_strip: {
        Args: { p_days?: number }
        Returns: {
          date: string
          feed: string
          rows_n: number
          state: string
        }[]
      }
      feed_health_rows: {
        Args: never
        Returns: {
          cadence_hours: number
          consecutive_failures: number
          coverage_edge: string
          coverage_lag_days: number
          days_to_expiry: number
          expires_at: string
          feed: string
          hours_since_success: number
          is_blocking: boolean
          label: string
          last_error: string
          last_run: string
          last_run_status: string
          last_success: string
          rows_last_run: number
          running_since: string
          status: string
          warning: string
          warning_level: string
        }[]
      }
      feed_recency_rows: {
        Args: never
        Returns: {
          allowed_lag_days: number
          coverage_edge: string
          feed: string
          is_blocking: boolean
          label: string
          lag_days: number
          sentence: string
          stalled: boolean
        }[]
      }
      golden_paid_l1_sales: {
        Args: { p_end: string; p_start: string }
        Returns: number
      }
      golden_status: {
        Args: never
        Returns: {
          computed_value: number
          delta: number
          error: string
          expected_value: number
          golden_id: string
          metric_id: string
          note: string
          pass: boolean
          run_at: string
          verified_by: string
          window_end: string
          window_start: string
        }[]
      }
      held_seats: {
        Args: { p_end: string; p_start: string }
        Returns: {
          balance_outstanding: number
          deposits_received: number
          held: number
        }[]
      }
      infer_lead_source: {
        Args: { p_tags: string[] }
        Returns: {
          inference_basis: string
          source_inferred: string
        }[]
      }
      inv_basis_symmetry_rows: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      inv_cron_alive_rows: { Args: never; Returns: Json }
      inv_cron_manifest_rows: { Args: never; Returns: Json }
      inv_data_recency_rows: { Args: never; Returns: Json }
      inv_level_history_rows: { Args: never; Returns: Json }
      inv_missed_runs_rows: { Args: never; Returns: Json }
      inv_orphan_history_rows: { Args: never; Returns: Json }
      inv_source_decision_rows: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      inv_spend_symmetry_rows: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      inv_unwitnessed_spend_rows: {
        Args: { p_end: string; p_start: string }
        Returns: {
          check_id: string
          checked_at: string
          divergence_pct: number
          for_date: string
          note: string
          primary_source: string
          primary_value: number
          verdict: string
          witness_source: string
          witness_value: number
        }[]
      }
      inv_view_security_invoker_rows: {
        Args: never
        Returns: {
          check_id: string
          checked_at: string
          divergence_pct: number
          for_date: string
          note: string
          primary_source: string
          primary_value: number
          verdict: string
          witness_source: string
          witness_value: number
        }[]
      }
      is_webinar_off_day: { Args: { p_date: string }; Returns: boolean }
      job_watch_rows: {
        Args: never
        Returns: {
          cadence_hours: number
          consequence: string
          hours_since_start: number
          jobname: string
          last_end: string
          last_start: string
          plain_label: string
          schedule: string
          sentence: string
          status: string
        }[]
      }
      judge_yield: { Args: { p_run_id: string }; Returns: string }
      judge_yield_of: {
        Args: {
          p_at: string
          p_rows: number
          p_run_id: string
          p_source: string
        }
        Returns: {
          expected: number
          note: string
          verdict: string
        }[]
      }
      l1_expected_price: {
        Args: { p_coupon: string; p_date: string }
        Returns: number
      }
      lead_agency_code: {
        Args: { p_ad_ref: string; p_utm_source: string }
        Returns: string
      }
      lead_agency_rollup: {
        Args: { p_since: string; p_until: string }
        Returns: {
          agency_code: string
          leads: number
          leads_with_email: number
          registered_leads: number
          sales: number
        }[]
      }
      lead_is_paid: { Args: { p_email: string }; Returns: boolean }
      lead_name_match_orphans: {
        Args: { p_days?: number }
        Returns: {
          orphan_leads: number
          orphan_names: number
          sample: string[]
        }[]
      }
      lead_page_rollup: {
        Args: { p_end?: string; p_start?: string }
        Returns: {
          first_date: string
          key_kind: string
          last_date: string
          leads: number
          page_key: string
          registered: number
        }[]
      }
      lead_template_trend: {
        Args: { p_days?: number }
        Returns: {
          day: string
          new_leads: number
          new_with_ad_id: number
          new_with_ref: number
          old_leads: number
          old_with_ad_id: number
          old_with_ref: number
        }[]
      }
      lead_tracking_coverage: {
        Args: { p_days?: number }
        Returns: {
          ad_id_pct: number
          ad_ref_pct: number
          campaign_pct: number
          first_capture: string
          last_capture: string
          leads_total: number
          name_exact: number
          name_fuzzy: number
          registered: number
          with_ad_id: number
          with_ad_ref: number
          with_campaign: number
          with_email: number
          without_email: number
        }[]
      }
      ledger_attribution_buckets: {
        Args: { p_end: string; p_start: string; p_tier?: string }
        Returns: {
          bucket: string
          buyers: number
          collected: number
          sales: number
        }[]
      }
      ledger_campaign_rollup: {
        Args: { p_end: string; p_start: string; p_tier?: string }
        Returns: {
          buyers: number
          collected: number
          is_paid: boolean
          platform: string
          sales: number
          utm_campaign: string
        }[]
      }
      ledger_daily: {
        Args: { p_end: string; p_start: string; p_tier?: string }
        Returns: {
          business_date: string
          collected: number
          pending: number
          rows_count: number
          sales: number
        }[]
      }
      ledger_day_short: { Args: { p_date: string }; Returns: boolean }
      ledger_lead_coverage: {
        Args: { p_end: string; p_start: string; p_tier?: string }
        Returns: {
          buyers: number
          campaign_pct: number
          coverage_pct: number
          leads_total: number
          matched: number
          unmatched: number
          with_campaign: number
        }[]
      }
      ledger_monthly: {
        Args: { p_end: string; p_start: string; p_tier?: string }
        Returns: {
          buyers: number
          collected: number
          period: string
          sales: number
        }[]
      }
      ledger_paid_daily: {
        Args: { p_end: string; p_start: string }
        Returns: {
          business_date: string
          collected_all: number
          collected_instalment: number
          collected_new_sale: number
          collected_no_lead: number
          collected_paid_exgst: number
          collected_paid_gross: number
          collected_unsynced_gross: number
          rows_all: number
          rows_paid: number
          rows_unsynced: number
        }[]
      }
      ledger_platform_rollup: {
        Args: { p_end: string; p_start: string; p_tier?: string }
        Returns: {
          buyers: number
          collected: number
          is_paid: boolean
          platform: string
          sales: number
        }[]
      }
      ledger_rail_rollup: {
        Args: { p_end: string; p_start: string; p_tier?: string }
        Returns: {
          collected: number
          receipt_source: string
          rows_count: number
          share_pct: number
        }[]
      }
      ledger_range_totals: {
        Args: { p_end: string; p_start: string; p_tier?: string }
        Returns: {
          buyers: number
          collected: number
          pending: number
          rows_count: number
          sales: number
        }[]
      }
      ledger_reconciliation: {
        Args: { p_end?: string; p_tier?: string; p_year?: number }
        Returns: Json
      }
      ledger_sale_timing_monthly: {
        Args: { p_end: string; p_start: string; p_tier?: string }
        Returns: {
          bucket: string
          collected: number
          lag_known: number
          period: string
          sales: number
        }[]
      }
      ledger_tier_rollup: {
        Args: { p_end: string; p_start: string }
        Returns: {
          avg_ticket: number
          buyers: number
          collected: number
          pending: number
          product_tier: string
          rows_count: number
          sales: number
        }[]
      }
      ledger_tier_summary: {
        Args: { p_end?: string; p_start?: string }
        Returns: {
          avg_ticket: number
          buyers: number
          collected: number
          first_date: string
          last_date: string
          product_tier: string
          sales: number
        }[]
      }
      ledger_unmatched_buyers: {
        Args: {
          p_end: string
          p_limit?: number
          p_start: string
          p_tier?: string
        }
        Returns: {
          collected: number
          email_key: string
          email_raw: string
          first_date: string
          last_date: string
          payer_name: string
          predates_lead_history: boolean
          receipt_source: string
          rows_count: number
          sales: number
        }[]
      }
      ledger_unmatched_summary: {
        Args: { p_end: string; p_start: string; p_tier?: string }
        Returns: {
          lead_history_start: string
          phone_conflicts: number
          phone_matched: number
          predating: number
          predating_pct: number
          total: number
        }[]
      }
      load_team_register: { Args: { p_rows: Json }; Returns: number }
      measured_ascension: {
        Args: never
        Returns: {
          ascended_buyers: number
          ascension_pct: number
          buyers_per_1000: number
          buyers_window_end: string
          buyers_window_start: string
          cohort_end: string
          cohort_start: string
          l1_avg_ticket: number
          l1_buyers: number
          l3_avg_ticket: number
        }[]
      }
      meta_accounts_uncovered: { Args: { p_date: string }; Returns: number }
      meta_agency_label: {
        Args: { p_ad_entity_ref: string; p_campaign: string }
        Returns: string
      }
      metric_components: {
        Args: { p_end: string; p_start: string }
        Returns: {
          at_60: number
          attendees: number
          attendees_matched: number
          collected: number
          date: string
          has_ledger: boolean
          has_meta: boolean
          has_tm: boolean
          has_zoom: boolean
          ledger_sales: number
          ledger_settling: boolean
          measured_spend: number
          paid_sales: number
          registrants: number
          registrations: number
          sales: number
          sessions_without_registrants: number
          spend: number
          tm_sales: number
        }[]
      }
      metric_month_values: {
        Args: { p_month_start: string }
        Returns: {
          metric_id: string
          value: number
        }[]
      }
      metric_series: {
        Args: { p_end: string; p_grain?: string; p_start: string }
        Returns: {
          complete: boolean
          days: number
          denom: number
          metric_id: string
          period_start: string
          rupees: number
          value: number
        }[]
      }
      monthly_spend: {
        Args: { p_year: number }
        Returns: {
          leads: number
          month: number
          spend: number
        }[]
      }
      nolead_buyer_rows: {
        Args: { p_since: string; p_until: string }
        Returns: {
          bucket: string
          collected: number
          decision: string
          email_key: string
          email_raw: string
          first_date: string
          last_date: string
          payer_name: string
          phone: string
          rows_count: number
          sales: number
        }[]
      }
      nolead_buyer_summary: {
        Args: { p_since: string; p_until: string }
        Returns: Json
      }
      nolead_owner_summary: { Args: { p_since: string }; Returns: Json }
      norm_ad_name: { Args: { p: string }; Returns: string }
      norm_phone: { Args: { p: string }; Returns: string }
      offer_timing_consistency: {
        Args: { _from: string; _to: string }
        Returns: {
          business_date: string
          deviation_minutes: number
          note: string
          observed_offer_minute: number
          script_offer_minute: number
          session_uuid: string
        }[]
      }
      paid_l1_new_sales_by_day: {
        Args: { p_end: string; p_start: string }
        Returns: {
          business_date: string
          paid_sales: number
        }[]
      }
      persona_medians: {
        Args: { p_days?: number }
        Returns: {
          median_cost_60: number
          median_cpl: number
          n_concepts: number
          persona: string
        }[]
      }
      placement_rollup: {
        Args: { p_end: string; p_start: string }
        Returns: {
          days_covered: number
          impressions: number
          leads: number
          link_clicks: number
          placement: string
          rows_n: number
          spend: number
        }[]
      }
      portfolio_balance: {
        Args: { p_days?: number }
        Returns: {
          dimension: string
          label: string
          share: number
          spend: number
        }[]
      }
      price_mix_by_source: {
        Args: { p_end: string; p_start: string }
        Returns: {
          avg_sale_value: number
          cash_received: number
          discount_given: number
          discounted_sales: number
          full_price_sales: number
          overseas_sales: number
          sales: number
          source: string
        }[]
      }
      price_mix_daily: {
        Args: { p_end: string; p_start: string }
        Returns: {
          avg_sale_value: number
          business_date: string
          cash_received: number
          discount_given: number
          discounted_sales: number
          full_price_sales: number
          overseas_sales: number
          promotion_sales: number
          sales: number
        }[]
      }
      price_mix_weekly: {
        Args: { p_code?: string }
        Returns: {
          avg_sale_value: number
          discount_given: number
          promotion_sales: number
          sales: number
          week_start: string
        }[]
      }
      promotion_totals: {
        Args: never
        Returns: {
          avg_sale_value: number
          cash_received: number
          code: string
          discount_given: number
          first_used: string
          last_used: string
          name: string
          sales: number
        }[]
      }
      promotions_in_window: {
        Args: { p_end: string; p_start: string }
        Returns: {
          code: string
          dates_confirmed: boolean
          discount_in_window: number
          discounted_price: number
          ends_on: string
          list_price: number
          name: string
          sales_in_window: number
          starts_on: string
        }[]
      }
      proof_closed_months: {
        Args: never
        Returns: {
          baseline: number
          ledger_sales: number
          month: string
          month_start: string
        }[]
      }
      proof_detail: {
        Args: { p_days: number }
        Returns: {
          check_id: string
          checked_at: string
          divergence_pct: number
          for_date: string
          note: string
          primary_source: string
          primary_value: number
          verdict: string
          witness_source: string
          witness_value: number
        }[]
      }
      proof_history_strip: {
        Args: { p_days?: number }
        Returns: {
          check_id: string
          for_date: string
          verdict: string
        }[]
      }
      proof_inputs: {
        Args: { p_end: string; p_start: string }
        Returns: {
          date: string
          leads_registered: number
          ledger_sales: number
          meta_spend: number
          settled: boolean
          tm_sales: number
          zoom_registrants: number
          zoom_sessions_n: number
          zoom_total_attendees: number
          zoom_valid_participants: number
        }[]
      }
      proof_summary: {
        Args: never
        Returns: {
          check_id: string
          days_checked: number
          diverged: number
          diverged_30d: number
          expected_noise: string
          family: string
          fp_budget_per_30d: number
          hours_since: number
          label: string
          last_run: string
          matches: number
          needs_recalibration: boolean
          plain: string
          primary_source: string
          status: string
          structural_note: string
          tolerable: number
          tolerance_note: string
          unavailable: number
          witness_source: string
          worst_date: string
          worst_divergence: number
          worst_note: string
          worst_primary: number
          worst_witness: number
        }[]
      }
      realised_sale_value_weekly: {
        Args: { p_weeks?: number }
        Returns: {
          avg_realised: number
          cash_received: number
          discount_given: number
          discounted_sales: number
          domestic_avg: number
          full_price_sales: number
          offers: string
          overseas_avg: number
          overseas_cash: number
          overseas_sales: number
          sales: number
          week_start: string
        }[]
      }
      reap_abandoned_runs: { Args: never; Returns: number }
      rebuild_agency_report: { Args: never; Returns: number }
      rebuild_lead_source_month: { Args: never; Returns: number }
      rebuild_metric_baselines: { Args: { p_asof?: string }; Returns: number }
      rebuild_metric_baselines_grain: {
        Args: { p_asof?: string; p_grain: string }
        Returns: number
      }
      rebuild_sale_attribution: { Args: never; Returns: number }
      rebuild_source_precompute: { Args: never; Returns: Json }
      rebuild_tm_sales: { Args: never; Returns: number }
      rebuild_unified_source_chunk: {
        Args: { p_bucket: number; p_buckets?: number }
        Returns: number
      }
      recompute_seat_sales: { Args: never; Returns: Json }
      reconcile_review_items: { Args: never; Returns: Json }
      record_reconciliations: { Args: { p_rows: Json }; Returns: number }
      recover_source_from_ad_fields: {
        Args: { p_limit?: number }
        Returns: number
      }
      refresh_agency_ratio_flags: {
        Args: { p_days?: number }
        Returns: {
          ad_coverage_pct: number
          agency_code: string
          ratio_note: string
          ratios_computable: boolean
          spend_synced: boolean
        }[]
      }
      refresh_lead_agency: {
        Args: { p_days?: number }
        Returns: {
          agency_code: string
          changed: number
          leads: number
        }[]
      }
      refresh_lead_attribution: { Args: never; Returns: string }
      refresh_lead_source_inference: {
        Args: { p_since?: string }
        Returns: number
      }
      refresh_lead_tracking_status: {
        Args: { p_days?: number }
        Returns: {
          new_status: string
          old_status: string
          out_account_id: string
          pct: number
        }[]
      }
      regime_boundaries: {
        Args: { p_end: string; p_start: string }
        Returns: {
          agency_code: string
          boundary_date: string
          event_key: string
          label: string
          plain: string
        }[]
      }
      resolve_lead_ad_refs: {
        Args: { p_days?: number; p_limit?: number; p_only_new?: boolean }
        Returns: {
          ambiguous: number
          id_matched: number
          name_exact: number
          name_fuzzy: number
          unmatched: number
        }[]
      }
      resolve_unified_source_incremental: {
        Args: { p_window?: string }
        Returns: number
      }
      retry_summary_rows: {
        Args: { p_days?: number }
        Returns: {
          last_at: string
          last_reason: string
          retries: number
          source: string
          step: string
        }[]
      }
      run_golden: {
        Args: { p_deploy_ref?: string; p_golden_id: string; p_trigger?: string }
        Returns: Json
      }
      run_golden_tests: {
        Args: { p_deploy_ref?: string; p_trigger?: string }
        Returns: Json
      }
      run_invariants: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      sabhi_ads: {
        Args: { p_end: string; p_start: string }
        Returns: {
          account_id: string
          ad_id: string
          ad_name: string
          buyers: number
          cash: number
          page_views: number
          registrations: number
          spend: number
        }[]
      }
      sabhi_bucket_of_account: { Args: { p_account: string }; Returns: string }
      sabhi_chain: {
        Args: { p_end: string; p_start: string }
        Returns: {
          at_price: number
          attended: number
          bucket: string
          buyers: number
          cash: number
          clicks: number
          last_spend: string
          page_views: number
          registrations: number
          spend: number
        }[]
      }
      sabhi_first_regs: {
        Args: { p_end: string; p_start: string }
        Returns: {
          ad_id: string
          bucket: string
          email_key: string
          reg_date: string
        }[]
      }
      sabhi_sales: {
        Args: { p_end: string; p_start: string }
        Returns: {
          ad_id: string
          bucket: string
          business_date: string
          cash: number
          email_key: string
          first_reg: string
        }[]
      }
      safety_net_rows: {
        Args: never
        Returns: {
          consequence: string
          key: string
          kind: string
          level: string
          text: string
        }[]
      }
      safety_net_selftest: { Args: never; Returns: Json }
      sale_person_match: {
        Args: { p_email: string }
        Returns: {
          how: string
          lead_email_key: string
        }[]
      }
      sale_source_disagreements: {
        Args: { p_end: string; p_start: string }
        Returns: {
          business_date: string
          cash: number
          email: string
          evidence: string
          sale_id: string
          team_answer: string
          tracking_answer: string
        }[]
      }
      sales_day_reconciliation: {
        Args: { p_date: string }
        Returns: {
          coupon_code: string
          currency: string
          email_key: string
          first_at: string
          ledger_inr: number
          ledger_payment_type: string
          list_price_inr: number
          person_name: string
          side: string
          tagmango_inr: number
        }[]
      }
      sales_reconciliation: {
        Args: { p_end: string; p_start: string }
        Returns: {
          collected: number
          date: string
          divergence_pct: number
          ledger_sales: number
          review: boolean
          settling: boolean
          tm_sales: number
        }[]
      }
      scaling_inputs: {
        Args: { p_date: string }
        Returns: {
          active_adsets: number
          attendees_60: number
          cost_per_60: number
          cpl: number
          days: number
          registrations: number
          sales: number
          spend: number
          window_label: string
        }[]
      }
      script_example_ads: {
        Args: { p_days?: number }
        Returns: {
          account_id: string
          entity_id: string
          permalink_url: string
          script_id: string
          thumbnail_url: string
        }[]
      }
      script_link_proposal_rows: {
        Args: never
        Returns: {
          account_id: string
          ad_entity_id: string
          ad_name: string
          basis: string
          confidence: number
          leads_30d: number
          permalink_url: string
          script_code: string
          script_id: string
          spend_30d: number
          thumbnail_url: string
          title: string
        }[]
      }
      script_mapping_queue: {
        Args: never
        Returns: {
          ad_entity_id: string
          ad_name: string
          confidence: number
          script_code: string
          script_id: string
          spend_30d: number
          title: string
        }[]
      }
      seat_completion_stats: {
        Args: { p_end: string; p_start: string }
        Returns: {
          balance_outstanding: number
          bookings: number
          completed: number
          completion_rate: number
          deposits_received: number
          held: number
          median_days: number
        }[]
      }
      session_t0: { Args: { p_start: string }; Returns: string }
      snapshot_feed_edges: { Args: never; Returns: number }
      snapshot_ledger_inflow: { Args: never; Returns: Json }
      source_month_matrix: {
        Args: { p_end: string; p_start: string }
        Returns: {
          cash: number
          channel: string
          confidence: string
          leads: number
          month: string
          sales_paid: number
          sales_team: number
          source: string
          tool: string
        }[]
      }
      source_pair_class: {
        Args: { p_hard_ad: boolean; p_team: string; p_track: string }
        Returns: string
      }
      spend_agency_month: {
        Args: never
        Returns: {
          agency_code: string
          month: string
          retarget: number
          spend: number
        }[]
      }
      spend_symmetry: {
        Args: { p_end: string; p_start: string }
        Returns: {
          excluded_cash: number
          excluded_rows: number
          teams: string[]
        }[]
      }
      stage_ledger_inflow: { Args: { p_rows: Json }; Returns: number }
      sync_health_rows: {
        Args: never
        Returns: {
          cadence_hours: number
          consecutive_failures: number
          hours_since_success: number
          is_critical: boolean
          label: string
          last_error: string
          last_run: string
          last_success: string
          source: string
          status: string
        }[]
      }
      sync_recent_runs: {
        Args: { p_limit?: number }
        Returns: {
          error: string
          expected_rows: number
          finished_at: string
          rows_written: number
          source: string
          started_at: string
          status: string
          yield_note: string
          yield_verdict: string
        }[]
      }
      team_register_counts: {
        Args: never
        Returns: {
          matched_sales: number
          register_rows: number
        }[]
      }
      team_register_person: {
        Args: never
        Returns: {
          email_key: string
          entry_date: string
          label: string
          matched_by: string
        }[]
      }
      team_source_label: { Args: { p_raw: string }; Returns: string }
      tm_order_fx_basis: { Args: { p_raw: Json }; Returns: string }
      tm_order_inr_amount: { Args: { p_raw: Json }; Returns: number }
      tm_reconciliation_queue: {
        Args: { p_limit?: number }
        Returns: {
          amount_via_tagmango: number
          business_date: string
          coupon_code: string
          expected_gross: number
          first_payment_at: string
          gap: number
          payment_route: string
          person_key: string
          revenue_status: string
          sale_id: string
        }[]
      }
      tm_row_counts: { Args: never; Returns: Json }
      tm_sales_coverage: {
        Args: { p_end: string; p_start: string }
        Returns: {
          buyers: number
          coverage_pct: number
          period: string
          sales: number
        }[]
      }
      tm_sales_daily: {
        Args: { p_end: string; p_start: string }
        Returns: {
          awaiting_ledger: number
          awaiting_value: number
          business_date: string
          located_gross: number
          located_net: number
          payment_route: string
          sales: number
          shortfall: number
        }[]
      }
      upsert_ad_entities: { Args: { p_rows: Json }; Returns: number }
      upsert_creative_scripts: {
        Args: { p_rows: Json; p_source?: string }
        Returns: number
      }
      upsert_daily_metrics: { Args: { p_rows: Json }; Returns: number }
      upsert_demo_metrics: { Args: { p_rows: Json }; Returns: number }
      upsert_leads: { Args: { p_rows: Json }; Returns: number }
      upsert_ledger_inflow: { Args: { p_rows: Json }; Returns: number }
      upsert_tm_enrolments: { Args: { p_rows: Json }; Returns: number }
      upsert_tm_payments: { Args: { p_rows: Json }; Returns: number }
      upsert_zoom_participants: { Args: { p_rows: Json }; Returns: number }
      upsert_zoom_sessions: { Args: { p_rows: Json }; Returns: number }
      verify_deploy: {
        Args: { p_deploy_ref: string; p_note?: string }
        Returns: Json
      }
      weekly_agency_rollup: {
        Args: { p_end: string; p_start: string }
        Returns: {
          agency_code: string
          attended: number
          buyers: number
          later_spend_90d: number
          registrations: number
          sales: number
          show_up_pct: number
        }[]
      }
      write_metric_baselines: { Args: { p_rows: Json }; Returns: number }
      zoom_event_rows: {
        Args: { p_end: string; p_include_test?: boolean; p_start: string }
        Returns: {
          at_30: number
          at_60: number
          at_90: number
          attendees: number
          attendees_matched: number
          event_date: string
          event_key: string
          first_start: string
          live_sessions: number
          registrants: number
          replay_sessions: number
          sessions: number
          sessions_missing_attendance: number
          sessions_without_registrants: number
        }[]
      }
      zoom_retention_curve: {
        Args: { p_session_uuid: string }
        Returns: {
          minute: number
          present: number
        }[]
      }
      zoom_session_rows: {
        Args: { p_end: string; p_include_test?: boolean; p_start: string }
        Returns: {
          at_30: number
          at_60: number
          at_90: number
          attendees: number
          business_date: string
          duration_min: number
          event_key: string
          invalid_rows: number
          participants_note: string
          participants_status: string
          session_role: string
          session_type: string
          session_uuid: string
          start_time: string
          topic: string
          topic_date: string
          total_registrants: number
          zoom_id: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
