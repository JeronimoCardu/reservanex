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
      ai_settings: {
        Row: {
          active: boolean
          assistant_name: string
          bot_send_property_links: boolean
          bot_tone: string
          bot_use_emojis: boolean
          created_at: string
          escalation_keywords: string[] | null
          id: string
          max_context_messages: number
          max_turns_before_escalation: number
          model: string
          pending_reservation_hold_minutes: number
          response_delay_ms: number
          system_prompt: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          assistant_name?: string
          bot_send_property_links?: boolean
          bot_tone?: string
          bot_use_emojis?: boolean
          created_at?: string
          escalation_keywords?: string[] | null
          id?: string
          max_context_messages?: number
          max_turns_before_escalation?: number
          model?: string
          pending_reservation_hold_minutes?: number
          response_delay_ms?: number
          system_prompt?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          assistant_name?: string
          bot_send_property_links?: boolean
          bot_tone?: string
          bot_use_emojis?: boolean
          created_at?: string
          escalation_keywords?: string[] | null
          id?: string
          max_context_messages?: number
          max_turns_before_escalation?: number
          model?: string
          pending_reservation_hold_minutes?: number
          response_delay_ms?: number
          system_prompt?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_log: {
        Row: {
          conversation_id: string | null
          cost_usd_cents: number | null
          created_at: string
          id: number
          input_tokens: number
          model: string
          output_tokens: number
          tenant_id: string
        }
        Insert: {
          conversation_id?: string | null
          cost_usd_cents?: number | null
          created_at?: string
          id?: never
          input_tokens: number
          model: string
          output_tokens: number
          tenant_id: string
        }
        Update: {
          conversation_id?: string | null
          cost_usd_cents?: number | null
          created_at?: string
          id?: never
          input_tokens?: number
          model?: string
          output_tokens?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_log_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: Database["public"]["Enums"]["audit_actor_type"]
          created_at: string
          entity_id: string | null
          entity_type: string
          id: number
          impersonated_by: string | null
          ip_address: unknown
          new_value: Json | null
          old_value: Json | null
          tenant_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type: Database["public"]["Enums"]["audit_actor_type"]
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: never
          impersonated_by?: string | null
          ip_address?: unknown
          new_value?: Json | null
          old_value?: Json | null
          tenant_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: Database["public"]["Enums"]["audit_actor_type"]
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: never
          impersonated_by?: string | null
          ip_address?: unknown
          new_value?: Json | null
          old_value?: Json | null
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_impersonated_by_fkey"
            columns: ["impersonated_by"]
            isOneToOne: false
            referencedRelation: "platform_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      availability_blocks: {
        Row: {
          created_at: string
          created_by: string | null
          end_date: string
          id: string
          reason: Database["public"]["Enums"]["block_reason"]
          reservation_id: string | null
          start_date: string
          tenant_id: string
          unit_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          end_date: string
          id?: string
          reason: Database["public"]["Enums"]["block_reason"]
          reservation_id?: string | null
          start_date: string
          tenant_id: string
          unit_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          end_date?: string
          id?: string
          reason?: Database["public"]["Enums"]["block_reason"]
          reservation_id?: string | null
          start_date?: string
          tenant_id?: string
          unit_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "availability_blocks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_blocks_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_blocks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_blocks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_blocks_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          created_at: string
          deleted_at: string | null
          email: string | null
          id: string
          name: string | null
          phone: string | null
          source: Database["public"]["Enums"]["contact_source"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          phone?: string | null
          source?: Database["public"]["Enums"]["contact_source"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          phone?: string | null
          source?: Database["public"]["Enums"]["contact_source"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_reservation_drafts: {
        Row: {
          conversation_id: string
          created_at: string
          deposit_required_amount: number | null
          end_date: string
          expires_at: string
          fees_amount: number
          guests: number
          nightly_price: number | null
          nights_count: number | null
          price_currency: string | null
          pricing_breakdown: Json
          pricing_mode: string
          property_id: string
          property_title: string
          start_date: string
          status: string
          subtotal_amount: number | null
          tenant_id: string
          total_amount: number | null
          updated_at: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          deposit_required_amount?: number | null
          end_date: string
          expires_at?: string
          fees_amount?: number
          guests?: number
          nightly_price?: number | null
          nights_count?: number | null
          price_currency?: string | null
          pricing_breakdown?: Json
          pricing_mode?: string
          property_id: string
          property_title?: string
          start_date: string
          status?: string
          subtotal_amount?: number | null
          tenant_id: string
          total_amount?: number | null
          updated_at?: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          deposit_required_amount?: number | null
          end_date?: string
          expires_at?: string
          fees_amount?: number
          guests?: number
          nightly_price?: number | null
          nights_count?: number | null
          price_currency?: string | null
          pricing_breakdown?: Json
          pricing_mode?: string
          property_id?: string
          property_title?: string
          start_date?: string
          status?: string
          subtotal_amount?: number | null
          tenant_id?: string
          total_amount?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          ai_auto_replies_count: number
          ai_auto_replies_limit: number
          ai_context_reset_at: string | null
          ai_handoff_at: string | null
          ai_handoff_reason: string | null
          ai_mode: Database["public"]["Enums"]["ai_mode"]
          ai_reactivated_at: string | null
          ai_reactivated_by: string | null
          assigned_user_id: string | null
          channel: Database["public"]["Enums"]["conversation_channel"]
          closed_at: string | null
          contact_id: string
          created_at: string
          human_attention_requested_at: string | null
          human_until: string | null
          id: string
          last_message_at: string | null
          last_message_content: string | null
          last_message_content_type: string | null
          last_message_id: string | null
          last_message_sender_type: string | null
          lead_context: Json
          lead_operation_type: string
          lead_source: string | null
          lead_status: string
          lead_status_updated_at: string | null
          lead_status_updated_by: string | null
          needs_human_attention: boolean
          pending_submission_id: string | null
          property_id: string | null
          source: Database["public"]["Enums"]["conversation_source"]
          status: Database["public"]["Enums"]["conversation_status"]
          tenant_id: string
          unit_id: string | null
          updated_at: string
          whatsapp_account_id: string | null
          whatsapp_thread_id: string | null
          workspace_id: string | null
        }
        Insert: {
          ai_auto_replies_count?: number
          ai_auto_replies_limit?: number
          ai_context_reset_at?: string | null
          ai_handoff_at?: string | null
          ai_handoff_reason?: string | null
          ai_mode?: Database["public"]["Enums"]["ai_mode"]
          ai_reactivated_at?: string | null
          ai_reactivated_by?: string | null
          assigned_user_id?: string | null
          channel?: Database["public"]["Enums"]["conversation_channel"]
          closed_at?: string | null
          contact_id: string
          created_at?: string
          human_attention_requested_at?: string | null
          human_until?: string | null
          id?: string
          last_message_at?: string | null
          last_message_content?: string | null
          last_message_content_type?: string | null
          last_message_id?: string | null
          last_message_sender_type?: string | null
          lead_context?: Json
          lead_operation_type?: string
          lead_source?: string | null
          lead_status?: string
          lead_status_updated_at?: string | null
          lead_status_updated_by?: string | null
          needs_human_attention?: boolean
          pending_submission_id?: string | null
          property_id?: string | null
          source?: Database["public"]["Enums"]["conversation_source"]
          status?: Database["public"]["Enums"]["conversation_status"]
          tenant_id: string
          unit_id?: string | null
          updated_at?: string
          whatsapp_account_id?: string | null
          whatsapp_thread_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          ai_auto_replies_count?: number
          ai_auto_replies_limit?: number
          ai_context_reset_at?: string | null
          ai_handoff_at?: string | null
          ai_handoff_reason?: string | null
          ai_mode?: Database["public"]["Enums"]["ai_mode"]
          ai_reactivated_at?: string | null
          ai_reactivated_by?: string | null
          assigned_user_id?: string | null
          channel?: Database["public"]["Enums"]["conversation_channel"]
          closed_at?: string | null
          contact_id?: string
          created_at?: string
          human_attention_requested_at?: string | null
          human_until?: string | null
          id?: string
          last_message_at?: string | null
          last_message_content?: string | null
          last_message_content_type?: string | null
          last_message_id?: string | null
          last_message_sender_type?: string | null
          lead_context?: Json
          lead_operation_type?: string
          lead_source?: string | null
          lead_status?: string
          lead_status_updated_at?: string | null
          lead_status_updated_by?: string | null
          needs_human_attention?: boolean
          pending_submission_id?: string | null
          property_id?: string | null
          source?: Database["public"]["Enums"]["conversation_source"]
          status?: Database["public"]["Enums"]["conversation_status"]
          tenant_id?: string
          unit_id?: string | null
          updated_at?: string
          whatsapp_account_id?: string | null
          whatsapp_thread_id?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_ai_reactivated_by_fkey"
            columns: ["ai_reactivated_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_assigned_user_id_fkey"
            columns: ["assigned_user_id"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_last_message_id_fkey"
            columns: ["last_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_pending_submission_id_fkey"
            columns: ["pending_submission_id"]
            isOneToOne: false
            referencedRelation: "form_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_whatsapp_account_id_fkey"
            columns: ["whatsapp_account_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          contact_id: string | null
          created_at: string
          document_type: Database["public"]["Enums"]["document_type"]
          file_size_bytes: number | null
          file_url: string
          id: string
          mime_type: string | null
          monthly_rental_contract_id: string | null
          name: string
          notes: string | null
          property_id: string | null
          receipt_number: string | null
          reservation_id: string | null
          source: string
          storage_bucket: string | null
          storage_path: string | null
          tenant_id: string
          unit_id: string | null
          updated_at: string
        }
        Insert: {
          contact_id?: string | null
          created_at?: string
          document_type: Database["public"]["Enums"]["document_type"]
          file_size_bytes?: number | null
          file_url: string
          id?: string
          mime_type?: string | null
          monthly_rental_contract_id?: string | null
          name: string
          notes?: string | null
          property_id?: string | null
          receipt_number?: string | null
          reservation_id?: string | null
          source?: string
          storage_bucket?: string | null
          storage_path?: string | null
          tenant_id: string
          unit_id?: string | null
          updated_at?: string
        }
        Update: {
          contact_id?: string | null
          created_at?: string
          document_type?: Database["public"]["Enums"]["document_type"]
          file_size_bytes?: number | null
          file_url?: string
          id?: string
          mime_type?: string | null
          monthly_rental_contract_id?: string | null
          name?: string
          notes?: string | null
          property_id?: string | null
          receipt_number?: string | null
          reservation_id?: string | null
          source?: string
          storage_bucket?: string | null
          storage_path?: string | null
          tenant_id?: string
          unit_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_monthly_rental_contract_id_fkey"
            columns: ["monthly_rental_contract_id"]
            isOneToOne: false
            referencedRelation: "monthly_rental_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      form_submissions: {
        Row: {
          confirmed_at: string | null
          contact_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          expires_at: string
          id: string
          idempotency_key: string
          intent: string
          payload: Json
          publication_ref: string | null
          reference: string
          source: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          confirmed_at?: string | null
          contact_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          expires_at: string
          id?: string
          idempotency_key: string
          intent: string
          payload?: Json
          publication_ref?: string | null
          reference: string
          source?: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          confirmed_at?: string | null
          contact_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          expires_at?: string
          id?: string
          idempotency_key?: string
          intent?: string
          payload?: Json
          publication_ref?: string | null
          reference?: string
          source?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "form_submissions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "form_submissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "form_submissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      impersonation_sessions: {
        Row: {
          ended_at: string | null
          id: string
          ip_address: unknown
          platform_user_id: string
          reason: string
          started_at: string
          target_tenant_id: string
        }
        Insert: {
          ended_at?: string | null
          id?: string
          ip_address?: unknown
          platform_user_id: string
          reason: string
          started_at?: string
          target_tenant_id: string
        }
        Update: {
          ended_at?: string | null
          id?: string
          ip_address?: unknown
          platform_user_id?: string
          reason?: string
          started_at?: string
          target_tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "impersonation_sessions_platform_user_id_fkey"
            columns: ["platform_user_id"]
            isOneToOne: false
            referencedRelation: "platform_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "impersonation_sessions_target_tenant_id_fkey"
            columns: ["target_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "impersonation_sessions_target_tenant_id_fkey"
            columns: ["target_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_rejections: {
        Row: {
          account_id: string | null
          created_at: string
          id: string
          internal_event_id: string
          provider: string
          reason: string
          sender_length: number | null
          tenant_id: string
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          id?: string
          internal_event_id: string
          provider: string
          reason: string
          sender_length?: number | null
          tenant_id: string
        }
        Update: {
          account_id?: string | null
          created_at?: string
          id?: string
          internal_event_id?: string
          provider?: string
          reason?: string
          sender_length?: number | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbound_rejections_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_rejections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_rejections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      media_events: {
        Row: {
          account_id: string
          conversation_id: string
          created_at: string
          dispatched_at: string | null
          error: string | null
          expected_filename: string | null
          id: string
          media_type: string
          message_id: string
          status: string
          storage_path: string | null
          tenant_id: string
          updated_at: string
          uploaded_at: string | null
        }
        Insert: {
          account_id: string
          conversation_id: string
          created_at?: string
          dispatched_at?: string | null
          error?: string | null
          expected_filename?: string | null
          id?: string
          media_type: string
          message_id: string
          status?: string
          storage_path?: string | null
          tenant_id: string
          updated_at?: string
          uploaded_at?: string | null
        }
        Update: {
          account_id?: string
          conversation_id?: string
          created_at?: string
          dispatched_at?: string | null
          error?: string | null
          expected_filename?: string | null
          id?: string
          media_type?: string
          message_id?: string
          status?: string
          storage_path?: string | null
          tenant_id?: string
          updated_at?: string
          uploaded_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "media_events_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_events_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: true
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      message_queue: {
        Row: {
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          processed_at: string | null
          processing_started_at: string | null
          raw_payload: Json
          scheduled_at: string
          status: Database["public"]["Enums"]["queue_status"]
          tenant_id: string
          updated_at: string
          whatsapp_account_id: string | null
        }
        Insert: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          processed_at?: string | null
          processing_started_at?: string | null
          raw_payload: Json
          scheduled_at?: string
          status?: Database["public"]["Enums"]["queue_status"]
          tenant_id: string
          updated_at?: string
          whatsapp_account_id?: string | null
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          processed_at?: string | null
          processing_started_at?: string | null
          raw_payload?: Json
          scheduled_at?: string
          status?: Database["public"]["Enums"]["queue_status"]
          tenant_id?: string
          updated_at?: string
          whatsapp_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "message_queue_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_queue_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_queue_whatsapp_account_id_fkey"
            columns: ["whatsapp_account_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string
          content_type: Database["public"]["Enums"]["message_content_type"]
          conversation_id: string
          created_at: string
          id: string
          media_storage_path: string | null
          metadata: Json | null
          sender_id: string | null
          sender_type: Database["public"]["Enums"]["message_sender"]
          tenant_id: string
          whatsapp_message_id: string | null
        }
        Insert: {
          content: string
          content_type?: Database["public"]["Enums"]["message_content_type"]
          conversation_id: string
          created_at?: string
          id?: string
          media_storage_path?: string | null
          metadata?: Json | null
          sender_id?: string | null
          sender_type: Database["public"]["Enums"]["message_sender"]
          tenant_id: string
          whatsapp_message_id?: string | null
        }
        Update: {
          content?: string
          content_type?: Database["public"]["Enums"]["message_content_type"]
          conversation_id?: string
          created_at?: string
          id?: string
          media_storage_path?: string | null
          metadata?: Json | null
          sender_id?: string | null
          sender_type?: Database["public"]["Enums"]["message_sender"]
          tenant_id?: string
          whatsapp_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      messaging_outbox: {
        Row: {
          account_id: string
          conversation_id: string
          created_at: string
          destination_phone: string
          device_ack_at: string | null
          dispatched_at: string | null
          error: string | null
          id: string
          message_id: string
          provider: string
          source: string
          status: string
          tenant_id: string
          text: string
          updated_at: string
        }
        Insert: {
          account_id: string
          conversation_id: string
          created_at?: string
          destination_phone: string
          device_ack_at?: string | null
          dispatched_at?: string | null
          error?: string | null
          id?: string
          message_id: string
          provider: string
          source: string
          status?: string
          tenant_id: string
          text: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          conversation_id?: string
          created_at?: string
          destination_phone?: string
          device_ack_at?: string | null
          dispatched_at?: string | null
          error?: string | null
          id?: string
          message_id?: string
          provider?: string
          source?: string
          status?: string
          tenant_id?: string
          text?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messaging_outbox_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_outbox_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_outbox_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_outbox_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messaging_outbox_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      monthly_rental_charges: {
        Row: {
          adjustments_amount: number
          amount_paid: number
          contract_id: string
          created_at: string
          due_date: string
          expenses_amount: number
          id: string
          late_fee_amount: number
          notes: string | null
          period_month: number
          period_year: number
          rent_amount: number
          services_amount: number
          status: string
          tenant_id: string
          total_amount: number
          updated_at: string
        }
        Insert: {
          adjustments_amount?: number
          amount_paid?: number
          contract_id: string
          created_at?: string
          due_date: string
          expenses_amount?: number
          id?: string
          late_fee_amount?: number
          notes?: string | null
          period_month: number
          period_year: number
          rent_amount: number
          services_amount?: number
          status?: string
          tenant_id: string
          total_amount: number
          updated_at?: string
        }
        Update: {
          adjustments_amount?: number
          amount_paid?: number
          contract_id?: string
          created_at?: string
          due_date?: string
          expenses_amount?: number
          id?: string
          late_fee_amount?: number
          notes?: string | null
          period_month?: number
          period_year?: number
          rent_amount?: number
          services_amount?: number
          status?: string
          tenant_id?: string
          total_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "monthly_rental_charges_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "monthly_rental_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_charges_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_charges_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      monthly_rental_contracts: {
        Row: {
          adjustment_frequency_months: number | null
          adjustment_notes: string | null
          adjustment_type: string | null
          contact_id: string
          contract_notes: string | null
          created_at: string
          created_by: string | null
          currency: string
          deleted_at: string | null
          deposit_amount: number | null
          deposit_paid: boolean
          due_day: number
          end_date: string | null
          expenses_amount: number | null
          id: string
          internal_notes: string | null
          property_id: string
          rent_amount: number
          services_notes: string | null
          start_date: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          adjustment_frequency_months?: number | null
          adjustment_notes?: string | null
          adjustment_type?: string | null
          contact_id: string
          contract_notes?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          deleted_at?: string | null
          deposit_amount?: number | null
          deposit_paid?: boolean
          due_day?: number
          end_date?: string | null
          expenses_amount?: number | null
          id?: string
          internal_notes?: string | null
          property_id: string
          rent_amount: number
          services_notes?: string | null
          start_date: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          adjustment_frequency_months?: number | null
          adjustment_notes?: string | null
          adjustment_type?: string | null
          contact_id?: string
          contract_notes?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          deleted_at?: string | null
          deposit_amount?: number | null
          deposit_paid?: boolean
          due_day?: number
          end_date?: string | null
          expenses_amount?: number | null
          id?: string
          internal_notes?: string | null
          property_id?: string
          rent_amount?: number
          services_notes?: string | null
          start_date?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "monthly_rental_contracts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_contracts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_contracts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_contracts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_contracts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      monthly_rental_payments: {
        Row: {
          amount: number
          charge_id: string
          contract_id: string
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          paid_at: string
          payment_method: string
          proof_document_id: string | null
          receipt_document_id: string | null
          status: string
          tenant_id: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount: number
          charge_id: string
          contract_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          paid_at: string
          payment_method?: string
          proof_document_id?: string | null
          receipt_document_id?: string | null
          status?: string
          tenant_id: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount?: number
          charge_id?: string
          contract_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          paid_at?: string
          payment_method?: string
          proof_document_id?: string | null
          receipt_document_id?: string | null
          status?: string
          tenant_id?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "monthly_rental_payments_charge_id_fkey"
            columns: ["charge_id"]
            isOneToOne: false
            referencedRelation: "monthly_rental_charges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_payments_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "monthly_rental_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_payments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_payments_proof_document_id_fkey"
            columns: ["proof_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_payments_receipt_document_id_fkey"
            columns: ["receipt_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_rental_payments_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          contact_id: string | null
          content: string
          conversation_id: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          monthly_rental_contract_id: string | null
          reservation_id: string | null
          tenant_id: string
        }
        Insert: {
          contact_id?: string | null
          content: string
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          monthly_rental_contract_id?: string | null
          reservation_id?: string | null
          tenant_id: string
        }
        Update: {
          contact_id?: string | null
          content?: string
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          monthly_rental_contract_id?: string | null
          reservation_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_monthly_rental_contract_id_fkey"
            columns: ["monthly_rental_contract_id"]
            isOneToOne: false
            referencedRelation: "monthly_rental_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          attempts: number
          channel: Database["public"]["Enums"]["notification_channel"]
          created_at: string
          error_message: string | null
          id: string
          payload: Json
          read_at: string | null
          recipient_id: string
          recipient_type: string
          sent_at: string | null
          status: Database["public"]["Enums"]["notification_status"]
          tenant_id: string
          type: Database["public"]["Enums"]["notification_type"]
        }
        Insert: {
          attempts?: number
          channel: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          error_message?: string | null
          id?: string
          payload?: Json
          read_at?: string | null
          recipient_id: string
          recipient_type: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          tenant_id: string
          type: Database["public"]["Enums"]["notification_type"]
        }
        Update: {
          attempts?: number
          channel?: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          error_message?: string | null
          id?: string
          payload?: Json
          read_at?: string | null
          recipient_id?: string
          recipient_type?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          tenant_id?: string
          type?: Database["public"]["Enums"]["notification_type"]
        }
        Relationships: [
          {
            foreignKeyName: "notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      operation_requests: {
        Row: {
          contact_id: string
          conversation_id: string | null
          created_at: string
          customer_confirmed_at: string
          decided_at: string | null
          decided_by: string | null
          decision_notes: string | null
          entity_id: string | null
          entity_title_snapshot: string | null
          entity_type: string | null
          id: string
          intent: string
          kind: string
          payload_snapshot: Json
          publication_ref: string | null
          requested_date: string | null
          requested_end_date: string | null
          requested_time: string | null
          source_submission_id: string
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          contact_id: string
          conversation_id?: string | null
          created_at?: string
          customer_confirmed_at: string
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          entity_id?: string | null
          entity_title_snapshot?: string | null
          entity_type?: string | null
          id?: string
          intent: string
          kind: string
          payload_snapshot: Json
          publication_ref?: string | null
          requested_date?: string | null
          requested_end_date?: string | null
          requested_time?: string | null
          source_submission_id: string
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          contact_id?: string
          conversation_id?: string | null
          created_at?: string
          customer_confirmed_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          entity_id?: string | null
          entity_title_snapshot?: string | null
          entity_type?: string | null
          id?: string
          intent?: string
          kind?: string
          payload_snapshot?: Json
          publication_ref?: string | null
          requested_date?: string | null
          requested_end_date?: string | null
          requested_time?: string | null
          source_submission_id?: string
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operation_requests_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_requests_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_requests_source_submission_id_fkey"
            columns: ["source_submission_id"]
            isOneToOne: true
            referencedRelation: "form_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_users: {
        Row: {
          active: boolean
          created_at: string
          email: string
          id: string
          name: string
          role: Database["public"]["Enums"]["platform_role"]
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          email: string
          id: string
          name: string
          role: Database["public"]["Enums"]["platform_role"]
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          email?: string
          id?: string
          name?: string
          role?: Database["public"]["Enums"]["platform_role"]
          updated_at?: string
        }
        Relationships: []
      }
      properties: {
        Row: {
          address: string | null
          area_m2: number | null
          attributes: Json
          base_price_per_night: number | null
          capacity: number | null
          check_in_time: string | null
          check_out_time: string | null
          city: string | null
          cleaning_fee: number
          commercial_status: string
          cover_image_storage_path: string | null
          cover_image_url: string | null
          created_at: string
          currency: string
          custom_fields: Json
          deleted_at: string | null
          description: string | null
          expenses_amount: number | null
          google_maps_url: string | null
          id: string
          internal_address: string | null
          location_label: string | null
          long_term_deposit_amount: number | null
          long_term_price_notes: string | null
          meta_description: string | null
          minimum_stay_nights: number
          monthly_rent_price: number | null
          neighborhood: string | null
          operation_type: string
          pricing_mode: string
          public_code: string | null
          published: boolean
          sale_price: number | null
          show_exact_address_public: boolean
          show_price_public: boolean
          slug: string | null
          temporary_deposit_amount: number | null
          temporary_deposit_percent: number | null
          temporary_price_notes: string | null
          tenant_id: string
          title: string
          updated_at: string
          workspace_id: string | null
        }
        Insert: {
          address?: string | null
          area_m2?: number | null
          attributes?: Json
          base_price_per_night?: number | null
          capacity?: number | null
          check_in_time?: string | null
          check_out_time?: string | null
          city?: string | null
          cleaning_fee?: number
          commercial_status?: string
          cover_image_storage_path?: string | null
          cover_image_url?: string | null
          created_at?: string
          currency?: string
          custom_fields?: Json
          deleted_at?: string | null
          description?: string | null
          expenses_amount?: number | null
          google_maps_url?: string | null
          id?: string
          internal_address?: string | null
          location_label?: string | null
          long_term_deposit_amount?: number | null
          long_term_price_notes?: string | null
          meta_description?: string | null
          minimum_stay_nights?: number
          monthly_rent_price?: number | null
          neighborhood?: string | null
          operation_type?: string
          pricing_mode?: string
          public_code?: string | null
          published?: boolean
          sale_price?: number | null
          show_exact_address_public?: boolean
          show_price_public?: boolean
          slug?: string | null
          temporary_deposit_amount?: number | null
          temporary_deposit_percent?: number | null
          temporary_price_notes?: string | null
          tenant_id: string
          title: string
          updated_at?: string
          workspace_id?: string | null
        }
        Update: {
          address?: string | null
          area_m2?: number | null
          attributes?: Json
          base_price_per_night?: number | null
          capacity?: number | null
          check_in_time?: string | null
          check_out_time?: string | null
          city?: string | null
          cleaning_fee?: number
          commercial_status?: string
          cover_image_storage_path?: string | null
          cover_image_url?: string | null
          created_at?: string
          currency?: string
          custom_fields?: Json
          deleted_at?: string | null
          description?: string | null
          expenses_amount?: number | null
          google_maps_url?: string | null
          id?: string
          internal_address?: string | null
          location_label?: string | null
          long_term_deposit_amount?: number | null
          long_term_price_notes?: string | null
          meta_description?: string | null
          minimum_stay_nights?: number
          monthly_rent_price?: number | null
          neighborhood?: string | null
          operation_type?: string
          pricing_mode?: string
          public_code?: string | null
          published?: boolean
          sale_price?: number | null
          show_exact_address_public?: boolean
          show_price_public?: boolean
          slug?: string | null
          temporary_deposit_amount?: number | null
          temporary_deposit_percent?: number | null
          temporary_price_notes?: string | null
          tenant_id?: string
          title?: string
          updated_at?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "properties_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      property_availability_blocks: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          end_date: string
          id: string
          property_id: string
          reason: string | null
          start_date: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          end_date: string
          id?: string
          property_id: string
          reason?: string | null
          start_date: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          end_date?: string
          id?: string
          property_id?: string
          reason?: string | null
          start_date?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_availability_blocks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_availability_blocks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_availability_blocks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_availability_blocks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      property_images: {
        Row: {
          alt: string | null
          created_at: string
          id: string
          image_url: string
          is_cover: boolean
          property_id: string
          sort_order: number
          storage_path: string | null
        }
        Insert: {
          alt?: string | null
          created_at?: string
          id?: string
          image_url: string
          is_cover?: boolean
          property_id: string
          sort_order?: number
          storage_path?: string | null
        }
        Update: {
          alt?: string | null
          created_at?: string
          id?: string
          image_url?: string
          is_cover?: boolean
          property_id?: string
          sort_order?: number
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "property_images_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      property_videos: {
        Row: {
          created_at: string
          created_by: string | null
          duration_seconds: number | null
          file_size_bytes: number
          id: string
          mime_type: string
          property_id: string
          sort_order: number
          storage_path: string
          tenant_id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          duration_seconds?: number | null
          file_size_bytes: number
          id?: string
          mime_type: string
          property_id: string
          sort_order?: number
          storage_path: string
          tenant_id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          duration_seconds?: number | null
          file_size_bytes?: number
          id?: string
          mime_type?: string
          property_id?: string
          sort_order?: number
          storage_path?: string
          tenant_id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_videos_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_videos_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_videos_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      reservation_events: {
        Row: {
          actor_id: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json
          reservation_id: string
          tenant_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          reservation_id: string
          tenant_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          reservation_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservation_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_events_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservation_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      reservations: {
        Row: {
          amount_paid: number | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          completed_at: string | null
          completed_by: string | null
          confirmed_at: string | null
          confirmed_by: string | null
          contact_id: string
          conversation_id: string | null
          created_at: string
          currency: string
          customer_notes: string | null
          deleted_at: string | null
          deposit_paid_at: string | null
          deposit_payment_proof_document_id: string | null
          deposit_required_amount: number | null
          end_date: string
          expires_at: string | null
          fees_amount: number
          full_payment_proof_document_id: string | null
          guests: number
          id: string
          nightly_price_snapshot: number | null
          nights_count: number | null
          notes: string | null
          paid_at: string | null
          payment_notes: string | null
          payment_status: string
          price_currency: string | null
          pricing_breakdown: Json
          pricing_mode_snapshot: string | null
          property_id: string | null
          source: string
          start_date: string
          status: Database["public"]["Enums"]["reservation_status"]
          subtotal_amount: number | null
          tenant_id: string
          total_amount: number | null
          unit_id: string | null
          updated_at: string
        }
        Insert: {
          amount_paid?: number | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          contact_id: string
          conversation_id?: string | null
          created_at?: string
          currency?: string
          customer_notes?: string | null
          deleted_at?: string | null
          deposit_paid_at?: string | null
          deposit_payment_proof_document_id?: string | null
          deposit_required_amount?: number | null
          end_date: string
          expires_at?: string | null
          fees_amount?: number
          full_payment_proof_document_id?: string | null
          guests: number
          id?: string
          nightly_price_snapshot?: number | null
          nights_count?: number | null
          notes?: string | null
          paid_at?: string | null
          payment_notes?: string | null
          payment_status?: string
          price_currency?: string | null
          pricing_breakdown?: Json
          pricing_mode_snapshot?: string | null
          property_id?: string | null
          source?: string
          start_date: string
          status?: Database["public"]["Enums"]["reservation_status"]
          subtotal_amount?: number | null
          tenant_id: string
          total_amount?: number | null
          unit_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_paid?: number | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          contact_id?: string
          conversation_id?: string | null
          created_at?: string
          currency?: string
          customer_notes?: string | null
          deleted_at?: string | null
          deposit_paid_at?: string | null
          deposit_payment_proof_document_id?: string | null
          deposit_required_amount?: number | null
          end_date?: string
          expires_at?: string | null
          fees_amount?: number
          full_payment_proof_document_id?: string | null
          guests?: number
          id?: string
          nightly_price_snapshot?: number | null
          nights_count?: number | null
          notes?: string | null
          paid_at?: string | null
          payment_notes?: string | null
          payment_status?: string
          price_currency?: string | null
          pricing_breakdown?: Json
          pricing_mode_snapshot?: string | null
          property_id?: string | null
          source?: string
          start_date?: string
          status?: Database["public"]["Enums"]["reservation_status"]
          subtotal_amount?: number | null
          tenant_id?: string
          total_amount?: number | null
          unit_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservations_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_deposit_payment_proof_document_id_fkey"
            columns: ["deposit_payment_proof_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_full_payment_proof_document_id_fkey"
            columns: ["full_payment_proof_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      seller_clients: {
        Row: {
          active: boolean
          commission_percentage: number
          created_at: string
          id: string
          seller_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          commission_percentage?: number
          created_at?: string
          id?: string
          seller_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          commission_percentage?: number
          created_at?: string
          id?: string
          seller_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "seller_clients_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "platform_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seller_clients_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seller_clients_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assigned_to: string | null
          completed_at: string | null
          contact_id: string | null
          conversation_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          due_date: string | null
          id: string
          monthly_rental_contract_id: string | null
          priority: string
          reservation_id: string | null
          status: Database["public"]["Enums"]["task_status"]
          tenant_id: string
          title: string
          updated_at: string
          workspace_id: string | null
        }
        Insert: {
          assigned_to?: string | null
          completed_at?: string | null
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          monthly_rental_contract_id?: string | null
          priority?: string
          reservation_id?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          tenant_id: string
          title: string
          updated_at?: string
          workspace_id?: string | null
        }
        Update: {
          assigned_to?: string | null
          completed_at?: string | null
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          monthly_rental_contract_id?: string | null
          priority?: string
          reservation_id?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          tenant_id?: string
          title?: string
          updated_at?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_monthly_rental_contract_id_fkey"
            columns: ["monthly_rental_contract_id"]
            isOneToOne: false
            referencedRelation: "monthly_rental_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_receipt_counters: {
        Row: {
          counter: number
          tenant_id: string
          updated_at: string
          year: number
        }
        Insert: {
          counter?: number
          tenant_id: string
          updated_at?: string
          year: number
        }
        Update: {
          counter?: number
          tenant_id?: string
          updated_at?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "tenant_receipt_counters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_receipt_counters_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_setup_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string
          id: string
          notes: string | null
          operator_id: string
          revoked_at: string | null
          revoked_by: string | null
          started_at: string | null
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          operator_id: string
          revoked_at?: string | null
          revoked_by?: string | null
          started_at?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          operator_id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          started_at?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_setup_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "platform_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_setup_assignments_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "platform_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_setup_assignments_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "platform_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_setup_assignments_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "platform_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_setup_assignments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_setup_assignments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_users: {
        Row: {
          active: boolean
          can_access_settings: boolean
          can_assign_conversations: boolean
          can_confirm_reservations: boolean
          can_create_properties: boolean
          created_at: string
          email: string
          id: string
          name: string
          role: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          can_access_settings?: boolean
          can_assign_conversations?: boolean
          can_confirm_reservations?: boolean
          can_create_properties?: boolean
          created_at?: string
          email: string
          id: string
          name: string
          role: Database["public"]["Enums"]["tenant_role"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          can_access_settings?: boolean
          can_assign_conversations?: boolean
          can_confirm_reservations?: boolean
          can_create_properties?: boolean
          created_at?: string
          email?: string
          id?: string
          name?: string
          role?: Database["public"]["Enums"]["tenant_role"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          assigned_seller_id: string | null
          business_hours: Json
          country: string
          created_at: string
          currency: string
          custom_domain: string | null
          deleted_at: string | null
          delivered_at: string | null
          delivered_by: string | null
          id: string
          language: string
          logo_url: string | null
          max_owners: number
          max_properties: number
          max_receptionists: number
          max_users: number
          name: string
          onboarding_notes: string | null
          onboarding_started_at: string | null
          onboarding_status: string
          owner_invited_at: string | null
          owner_invited_by: string | null
          payment_account_holder: string | null
          payment_alias: string | null
          payment_bank: string | null
          payment_cbu: string | null
          payment_notes: string | null
          payment_request_message: string | null
          plan: Database["public"]["Enums"]["plan_tier"]
          plan_code: string | null
          plan_label: string | null
          primary_color: string | null
          primary_owner_email: string | null
          primary_owner_name: string | null
          primary_owner_phone: string | null
          public_about_html: string | null
          public_cover_image_storage_path: string | null
          public_cover_image_url: string | null
          public_description: string | null
          public_email: string | null
          public_facebook_url: string | null
          public_instagram_url: string | null
          public_logo_storage_path: string | null
          public_logo_url: string | null
          public_name: string | null
          public_phone: string | null
          public_primary_color: string | null
          public_secondary_color: string | null
          public_site_enabled: boolean
          public_slug: string | null
          public_tiktok_url: string | null
          public_wa_pretext: string | null
          public_website_url: string | null
          ready_to_deliver_at: string | null
          receipt_footer_text: string | null
          receipt_show_logo: boolean
          rejected_at: string | null
          rejected_by: string | null
          secondary_color: string | null
          setup_status: string
          site_config: Json
          slug: string
          status: Database["public"]["Enums"]["tenant_status"]
          timezone: string
          trial_ends_at: string | null
          updated_at: string
          vertical: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          assigned_seller_id?: string | null
          business_hours?: Json
          country?: string
          created_at?: string
          currency?: string
          custom_domain?: string | null
          deleted_at?: string | null
          delivered_at?: string | null
          delivered_by?: string | null
          id?: string
          language?: string
          logo_url?: string | null
          max_owners?: number
          max_properties?: number
          max_receptionists?: number
          max_users?: number
          name: string
          onboarding_notes?: string | null
          onboarding_started_at?: string | null
          onboarding_status?: string
          owner_invited_at?: string | null
          owner_invited_by?: string | null
          payment_account_holder?: string | null
          payment_alias?: string | null
          payment_bank?: string | null
          payment_cbu?: string | null
          payment_notes?: string | null
          payment_request_message?: string | null
          plan?: Database["public"]["Enums"]["plan_tier"]
          plan_code?: string | null
          plan_label?: string | null
          primary_color?: string | null
          primary_owner_email?: string | null
          primary_owner_name?: string | null
          primary_owner_phone?: string | null
          public_about_html?: string | null
          public_cover_image_storage_path?: string | null
          public_cover_image_url?: string | null
          public_description?: string | null
          public_email?: string | null
          public_facebook_url?: string | null
          public_instagram_url?: string | null
          public_logo_storage_path?: string | null
          public_logo_url?: string | null
          public_name?: string | null
          public_phone?: string | null
          public_primary_color?: string | null
          public_secondary_color?: string | null
          public_site_enabled?: boolean
          public_slug?: string | null
          public_tiktok_url?: string | null
          public_wa_pretext?: string | null
          public_website_url?: string | null
          ready_to_deliver_at?: string | null
          receipt_footer_text?: string | null
          receipt_show_logo?: boolean
          rejected_at?: string | null
          rejected_by?: string | null
          secondary_color?: string | null
          setup_status?: string
          site_config?: Json
          slug: string
          status?: Database["public"]["Enums"]["tenant_status"]
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          vertical?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          assigned_seller_id?: string | null
          business_hours?: Json
          country?: string
          created_at?: string
          currency?: string
          custom_domain?: string | null
          deleted_at?: string | null
          delivered_at?: string | null
          delivered_by?: string | null
          id?: string
          language?: string
          logo_url?: string | null
          max_owners?: number
          max_properties?: number
          max_receptionists?: number
          max_users?: number
          name?: string
          onboarding_notes?: string | null
          onboarding_started_at?: string | null
          onboarding_status?: string
          owner_invited_at?: string | null
          owner_invited_by?: string | null
          payment_account_holder?: string | null
          payment_alias?: string | null
          payment_bank?: string | null
          payment_cbu?: string | null
          payment_notes?: string | null
          payment_request_message?: string | null
          plan?: Database["public"]["Enums"]["plan_tier"]
          plan_code?: string | null
          plan_label?: string | null
          primary_color?: string | null
          primary_owner_email?: string | null
          primary_owner_name?: string | null
          primary_owner_phone?: string | null
          public_about_html?: string | null
          public_cover_image_storage_path?: string | null
          public_cover_image_url?: string | null
          public_description?: string | null
          public_email?: string | null
          public_facebook_url?: string | null
          public_instagram_url?: string | null
          public_logo_storage_path?: string | null
          public_logo_url?: string | null
          public_name?: string | null
          public_phone?: string | null
          public_primary_color?: string | null
          public_secondary_color?: string | null
          public_site_enabled?: boolean
          public_slug?: string | null
          public_tiktok_url?: string | null
          public_wa_pretext?: string | null
          public_website_url?: string | null
          ready_to_deliver_at?: string | null
          receipt_footer_text?: string | null
          receipt_show_logo?: boolean
          rejected_at?: string | null
          rejected_by?: string | null
          secondary_color?: string | null
          setup_status?: string
          site_config?: Json
          slug?: string
          status?: Database["public"]["Enums"]["tenant_status"]
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          vertical?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenants_assigned_seller_id_fkey"
            columns: ["assigned_seller_id"]
            isOneToOne: false
            referencedRelation: "platform_users"
            referencedColumns: ["id"]
          },
        ]
      }
      unit_images: {
        Row: {
          created_at: string
          id: string
          image_url: string
          is_cover: boolean
          sort_order: number
          unit_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          image_url: string
          is_cover?: boolean
          sort_order?: number
          unit_id: string
        }
        Update: {
          created_at?: string
          id?: string
          image_url?: string
          is_cover?: boolean
          sort_order?: number
          unit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "unit_images_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      units: {
        Row: {
          active: boolean
          capacity: number
          created_at: string
          currency: string
          deleted_at: string | null
          id: string
          name: string
          price: number | null
          property_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          capacity: number
          created_at?: string
          currency?: string
          deleted_at?: string | null
          id?: string
          name: string
          price?: number | null
          property_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          capacity?: number
          created_at?: string
          currency?: string
          deleted_at?: string | null
          id?: string
          name?: string
          price?: number | null
          property_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "units_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "units_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "units_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      user_section_seen: {
        Row: {
          last_seen_at: string
          section: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          last_seen_at?: string
          section: string
          tenant_id: string
          user_id: string
        }
        Update: {
          last_seen_at?: string
          section?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_section_seen_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_section_seen_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_section_seen_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_workspace_assignments: {
        Row: {
          created_at: string
          id: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_workspace_assignments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_workspace_assignments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_accounts: {
        Row: {
          access_token_encrypted: string | null
          active: boolean
          business_account_id: string | null
          created_at: string
          device_dispatch_reserved_until: string | null
          device_name: string | null
          display_phone_number: string | null
          id: string
          inbound_token_hash: string | null
          last_device_seen_at: string | null
          last_inbound_at: string | null
          last_media_upload_at: string | null
          last_outbound_device_ack_at: string | null
          last_outbound_dispatch_at: string | null
          last_verified_at: string | null
          macrodroid_webhook_url: string | null
          phone_number: string
          provider: string
          tenant_id: string
          token_expires_at: string | null
          updated_at: string
          webhook_secret: string | null
          workspace_id: string | null
        }
        Insert: {
          access_token_encrypted?: string | null
          active?: boolean
          business_account_id?: string | null
          created_at?: string
          device_dispatch_reserved_until?: string | null
          device_name?: string | null
          display_phone_number?: string | null
          id?: string
          inbound_token_hash?: string | null
          last_device_seen_at?: string | null
          last_inbound_at?: string | null
          last_media_upload_at?: string | null
          last_outbound_device_ack_at?: string | null
          last_outbound_dispatch_at?: string | null
          last_verified_at?: string | null
          macrodroid_webhook_url?: string | null
          phone_number: string
          provider?: string
          tenant_id: string
          token_expires_at?: string | null
          updated_at?: string
          webhook_secret?: string | null
          workspace_id?: string | null
        }
        Update: {
          access_token_encrypted?: string | null
          active?: boolean
          business_account_id?: string | null
          created_at?: string
          device_dispatch_reserved_until?: string | null
          device_name?: string | null
          display_phone_number?: string | null
          id?: string
          inbound_token_hash?: string | null
          last_device_seen_at?: string | null
          last_inbound_at?: string | null
          last_media_upload_at?: string | null
          last_outbound_device_ack_at?: string | null
          last_outbound_dispatch_at?: string | null
          last_verified_at?: string | null
          macrodroid_webhook_url?: string | null
          phone_number?: string
          provider?: string
          tenant_id?: string
          token_expires_at?: string | null
          updated_at?: string
          webhook_secret?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_accounts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          active: boolean
          address: string | null
          city: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          phone: string | null
          tenant_id: string
          type: Database["public"]["Enums"]["workspace_type"]
          updated_at: string
        }
        Insert: {
          active?: boolean
          address?: string | null
          city?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          tenant_id: string
          type?: Database["public"]["Enums"]["workspace_type"]
          updated_at?: string
        }
        Update: {
          active?: boolean
          address?: string | null
          city?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          tenant_id?: string
          type?: Database["public"]["Enums"]["workspace_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspaces_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants_public"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      tenants_public: {
        Row: {
          custom_domain: string | null
          id: string | null
          logo_url: string | null
          name: string | null
          primary_color: string | null
          public_cover_image_url: string | null
          public_description: string | null
          public_email: string | null
          public_instagram_url: string | null
          public_name: string | null
          public_phone: string | null
          public_primary_color: string | null
          public_site_enabled: boolean | null
          public_slug: string | null
          public_website_url: string | null
          secondary_color: string | null
          site_config: Json | null
          slug: string | null
        }
        Insert: {
          custom_domain?: string | null
          id?: string | null
          logo_url?: string | null
          name?: string | null
          primary_color?: string | null
          public_cover_image_url?: string | null
          public_description?: string | null
          public_email?: string | null
          public_instagram_url?: string | null
          public_name?: string | null
          public_phone?: string | null
          public_primary_color?: string | null
          public_site_enabled?: boolean | null
          public_slug?: string | null
          public_website_url?: string | null
          secondary_color?: string | null
          site_config?: Json | null
          slug?: string | null
        }
        Update: {
          custom_domain?: string | null
          id?: string | null
          logo_url?: string | null
          name?: string | null
          primary_color?: string | null
          public_cover_image_url?: string | null
          public_description?: string | null
          public_email?: string | null
          public_instagram_url?: string | null
          public_name?: string | null
          public_phone?: string | null
          public_primary_color?: string | null
          public_site_enabled?: boolean | null
          public_slug?: string | null
          public_website_url?: string | null
          secondary_color?: string | null
          site_config?: Json | null
          slug?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      admin_purge_tenant: { Args: { p_tenant_id: string }; Returns: Json }
      auth_impersonating_tenant_id: { Args: never; Returns: string }
      auth_tenant_id: { Args: never; Returns: string }
      auth_user_role: { Args: never; Returns: string }
      auth_user_type: { Args: never; Returns: string }
      auth_workspace_ids: { Args: never; Returns: string[] }
      claim_ai_auto_reply_slot: {
        Args: { p_conversation_id: string; p_tenant_id: string }
        Returns: {
          claimed: boolean
          is_last: boolean
          new_count: number
          reply_limit: number
        }[]
      }
      claim_next_media_event: {
        Args: { p_lease_seconds?: number }
        Returns: {
          account_id: string
          conversation_id: string
          created_at: string
          dispatched_at: string | null
          error: string | null
          expected_filename: string | null
          id: string
          media_type: string
          message_id: string
          status: string
          storage_path: string | null
          tenant_id: string
          updated_at: string
          uploaded_at: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "media_events"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_next_outbox_item: {
        Args: { p_cooldown_seconds?: number; p_lease_seconds?: number }
        Returns: {
          account_id: string
          conversation_id: string
          created_at: string
          destination_phone: string
          device_ack_at: string | null
          dispatched_at: string | null
          error: string | null
          id: string
          message_id: string
          provider: string
          source: string
          status: string
          tenant_id: string
          text: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "messaging_outbox"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      compute_charge_status_from_payment: {
        Args: {
          p_amount_paid: number
          p_due_date: string
          p_total_amount: number
        }
        Returns: string
      }
      confirm_submission_and_create_operation: {
        Args: {
          p_contact_id: string
          p_conversation_id?: string
          p_submission_id: string
          p_tenant_id: string
        }
        Returns: Json
      }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      decide_operation_request: {
        Args: { p_action: string; p_notes?: string; p_operation_id: string }
        Returns: Json
      }
      is_operator: { Args: never; Returns: boolean }
      is_operator_in_setup: { Args: never; Returns: boolean }
      is_owner: { Args: never; Returns: boolean }
      is_platform_user: { Args: never; Returns: boolean }
      is_receptionist: { Args: never; Returns: boolean }
      is_seller: { Args: never; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      is_tenant_user: { Args: never; Returns: boolean }
      next_receipt_number: { Args: { p_tenant_id: string }; Returns: string }
      normalize_contact_phone_ar: { Args: { phone: string }; Returns: string }
      record_monthly_rental_payment: {
        Args: {
          p_amount: number
          p_charge_id: string
          p_notes?: string
          p_paid_at: string
          p_payment_method: string
        }
        Returns: Json
      }
      refresh_conversation_last_message: {
        Args: { p_conversation_id: string; p_tenant_id: string }
        Returns: undefined
      }
      verify_hook_configured: { Args: never; Returns: boolean }
      void_monthly_rental_payment: {
        Args: { p_payment_id: string; p_reason?: string }
        Returns: Json
      }
    }
    Enums: {
      ai_mode: "manual" | "assisted" | "autonomous"
      audit_actor_type: "platform_user" | "tenant_user" | "system"
      block_reason: "reservation" | "maintenance" | "manual"
      contact_source: "whatsapp" | "website" | "manual"
      conversation_channel: "whatsapp" | "manual"
      conversation_source: "whatsapp_direct" | "website_button" | "manual"
      conversation_status: "open" | "waiting" | "closed"
      document_type:
        | "contract"
        | "regulation"
        | "policy"
        | "manual"
        | "payment_proof"
        | "receipt"
        | "identity_document"
        | "guarantee"
      message_content_type: "text" | "image" | "document" | "audio" | "video"
      message_sender: "customer" | "ai" | "human"
      notification_channel: "whatsapp" | "email" | "in_app"
      notification_status: "pending" | "sent" | "failed"
      notification_type:
        | "new_conversation"
        | "new_reservation"
        | "ai_escalation"
        | "reservation_confirmed"
        | "reservation_cancelled"
        | "payment_received"
      plan_tier: "starter" | "pro"
      platform_role: "super_admin" | "seller" | "operator"
      queue_status: "pending" | "processing" | "completed" | "failed"
      reservation_status:
        | "inquiry"
        | "interested"
        | "pre_reserved"
        | "pending_payment"
        | "confirmed"
        | "cancelled"
        | "completed"
      task_status: "pending" | "in_progress" | "completed" | "cancelled"
      tenant_role: "owner" | "receptionist"
      tenant_status: "trial" | "active" | "suspended" | "churned" | "cancelled"
      workspace_type: "general" | "physical_branch" | "zone" | "team"
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
    Enums: {
      ai_mode: ["manual", "assisted", "autonomous"],
      audit_actor_type: ["platform_user", "tenant_user", "system"],
      block_reason: ["reservation", "maintenance", "manual"],
      contact_source: ["whatsapp", "website", "manual"],
      conversation_channel: ["whatsapp", "manual"],
      conversation_source: ["whatsapp_direct", "website_button", "manual"],
      conversation_status: ["open", "waiting", "closed"],
      document_type: [
        "contract",
        "regulation",
        "policy",
        "manual",
        "payment_proof",
        "receipt",
        "identity_document",
        "guarantee",
      ],
      message_content_type: ["text", "image", "document", "audio", "video"],
      message_sender: ["customer", "ai", "human"],
      notification_channel: ["whatsapp", "email", "in_app"],
      notification_status: ["pending", "sent", "failed"],
      notification_type: [
        "new_conversation",
        "new_reservation",
        "ai_escalation",
        "reservation_confirmed",
        "reservation_cancelled",
        "payment_received",
      ],
      plan_tier: ["starter", "pro"],
      platform_role: ["super_admin", "seller", "operator"],
      queue_status: ["pending", "processing", "completed", "failed"],
      reservation_status: [
        "inquiry",
        "interested",
        "pre_reserved",
        "pending_payment",
        "confirmed",
        "cancelled",
        "completed",
      ],
      task_status: ["pending", "in_progress", "completed", "cancelled"],
      tenant_role: ["owner", "receptionist"],
      tenant_status: ["trial", "active", "suspended", "churned", "cancelled"],
      workspace_type: ["general", "physical_branch", "zone", "team"],
    },
  },
} as const
