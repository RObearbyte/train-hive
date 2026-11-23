/**
 * Hand-written mirror of docs/API_CONTRACT.md, in the shape that
 * `supabase gen types typescript` produces.
 *
 * When a hosted project exists, replace everything ABOVE the
 * "Convenience aliases" marker with the generated output and keep the
 * aliases section: callers only depend on `Database` and on the aliases.
 *
 * Timestamps (`timestamptz`) are ISO 8601 strings in UTC.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** `attendance_audit_log.action` (a text column with a check constraint, not an enum). */
export type AttendanceAuditAction = 'record' | 'correct' | 'walk_in_add';

/** `device_push_tokens.platform` (text with a check constraint). */
export type PushPlatform = 'ios' | 'android' | 'web';

/** `notification_delivery_jobs.status` (text with a check constraint). */
export type NotificationJobStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'dead' | 'skipped';

/** `p_status` of `complete_notification_job`. */
export type NotificationJobOutcome = 'sent' | 'skipped' | 'failed' | 'dead';

export type Database = {
  public: {
    Tables: {
      communities: {
        Row: {
          id: string;
          name: string;
          timezone: string;
          created_at: string;
          /**
           * C3: millisecond precision, bumped by every change through update_community. Always
           * present (not null in SQL); typed optional like the other columns added with
           * `alter table` (attendance_finalized_by) because qa-backendContract.test.ts only
           * parses `create table`.
           */
          updated_at?: string;
        };
        Insert: {
          id?: string;
          name: string;
          timezone: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          timezone?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          display_name: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          display_name?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      memberships: {
        Row: {
          id: string;
          community_id: string;
          user_id: string;
          role: Database['public']['Enums']['membership_role'];
          status: Database['public']['Enums']['membership_status'];
          joined_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          user_id: string;
          role?: Database['public']['Enums']['membership_role'];
          status?: Database['public']['Enums']['membership_status'];
          joined_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          user_id?: string;
          role?: Database['public']['Enums']['membership_role'];
          status?: Database['public']['Enums']['membership_status'];
          joined_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memberships_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memberships_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      invitation_codes: {
        Row: {
          id: string;
          community_id: string;
          code: string;
          role: Database['public']['Enums']['membership_role'];
          created_by: string | null;
          expires_at: string | null;
          max_redemptions: number | null;
          redemption_count: number;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          code: string;
          role?: Database['public']['Enums']['membership_role'];
          created_by?: string | null;
          expires_at?: string | null;
          max_redemptions?: number | null;
          redemption_count?: number;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          code?: string;
          role?: Database['public']['Enums']['membership_role'];
          created_by?: string | null;
          expires_at?: string | null;
          max_redemptions?: number | null;
          redemption_count?: number;
          revoked_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'invitation_codes_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'invitation_codes_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      invitation_redemptions: {
        Row: {
          id: string;
          invitation_id: string;
          user_id: string;
          redeemed_at: string;
        };
        Insert: {
          id?: string;
          invitation_id: string;
          user_id: string;
          redeemed_at?: string;
        };
        Update: {
          id?: string;
          invitation_id?: string;
          user_id?: string;
          redeemed_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'invitation_redemptions_invitation_id_fkey';
            columns: ['invitation_id'];
            isOneToOne: false;
            referencedRelation: 'invitation_codes';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'invitation_redemptions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      invitation_attempts: {
        Row: {
          id: string;
          user_id: string;
          attempted_at: string;
          success: boolean;
        };
        Insert: {
          id?: string;
          user_id: string;
          attempted_at?: string;
          success: boolean;
        };
        Update: {
          id?: string;
          user_id?: string;
          attempted_at?: string;
          success?: boolean;
        };
        Relationships: [];
      };
      activity_types: {
        Row: {
          key: string;
          label: string;
          sort_order: number;
        };
        Insert: {
          key: string;
          label: string;
          sort_order?: number;
        };
        Update: {
          key?: string;
          label?: string;
          sort_order?: number;
        };
        Relationships: [];
      };
      /** P1: subtypes per event kind (select-only for authenticated). */
      event_subtypes: {
        Row: {
          kind: Database['public']['Enums']['event_kind'];
          key: string;
          label: string;
          sort_order: number;
          /** Legacy activity type written to training_sessions.activity_type for this subtype. */
          activity_type: string;
        };
        Insert: {
          kind: Database['public']['Enums']['event_kind'];
          key: string;
          label: string;
          sort_order?: number;
          activity_type: string;
        };
        Update: {
          kind?: Database['public']['Enums']['event_kind'];
          key?: string;
          label?: string;
          sort_order?: number;
          activity_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'event_subtypes_activity_type_fkey';
            columns: ['activity_type'];
            isOneToOne: false;
            referencedRelation: 'activity_types';
            referencedColumns: ['key'];
          },
        ];
      };
      training_sessions: {
        Row: {
          id: string;
          community_id: string;
          organizer_id: string | null;
          title: string;
          description: string | null;
          activity_type: string;
          starts_at: string;
          ends_at: string | null;
          rsvp_deadline: string;
          timezone: string;
          location_name: string;
          address: string | null;
          latitude: number | null;
          longitude: number | null;
          map_url: string | null;
          meeting_instructions: string | null;
          /** Trainings only (>= 1); null for every other event kind. */
          min_participants: number | null;
          max_participants: number | null;
          going_count: number;
          status: Database['public']['Enums']['session_status'];
          /** P1. Immutable after creation. */
          event_kind: Database['public']['Enums']['event_kind'];
          /** P1. A key of event_subtypes for this kind. activity_type is derived from it. */
          event_subtype: string;
          /** P1. numeric(6,2) km; PostgREST returns it as a JSON number. */
          distance_km: number | null;
          /** P1. D+ in metres. */
          elevation_gain_m: number | null;
          /** P1. OCR subtype only. */
          obstacle_count: number | null;
          event_notes: string | null;
          cancel_reason: Database['public']['Enums']['cancel_reason'] | null;
          cancellation_reason: string | null;
          decided_at: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          // M2. The server always returns both. Optional only until the session fixtures in
          // src/**/*.test.ts (mobile / QA lane) include them; then make them required.
          attendance_finalized_at?: string | null;
          attendance_finalized_by?: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          organizer_id?: string | null;
          title: string;
          description?: string | null;
          activity_type?: string;
          starts_at: string;
          ends_at?: string | null;
          rsvp_deadline: string;
          timezone: string;
          location_name: string;
          address?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          map_url?: string | null;
          meeting_instructions?: string | null;
          min_participants?: number | null;
          max_participants?: number | null;
          going_count?: number;
          status?: Database['public']['Enums']['session_status'];
          event_kind?: Database['public']['Enums']['event_kind'];
          event_subtype?: string;
          distance_km?: number | null;
          elevation_gain_m?: number | null;
          obstacle_count?: number | null;
          event_notes?: string | null;
          cancel_reason?: Database['public']['Enums']['cancel_reason'] | null;
          cancellation_reason?: string | null;
          decided_at?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          attendance_finalized_at?: string | null;
          attendance_finalized_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          organizer_id?: string | null;
          title?: string;
          description?: string | null;
          activity_type?: string;
          starts_at?: string;
          ends_at?: string | null;
          rsvp_deadline?: string;
          timezone?: string;
          location_name?: string;
          address?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          map_url?: string | null;
          meeting_instructions?: string | null;
          min_participants?: number | null;
          max_participants?: number | null;
          going_count?: number;
          status?: Database['public']['Enums']['session_status'];
          event_kind?: Database['public']['Enums']['event_kind'];
          event_subtype?: string;
          distance_km?: number | null;
          elevation_gain_m?: number | null;
          obstacle_count?: number | null;
          event_notes?: string | null;
          cancel_reason?: Database['public']['Enums']['cancel_reason'] | null;
          cancellation_reason?: string | null;
          decided_at?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          attendance_finalized_at?: string | null;
          attendance_finalized_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'training_sessions_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'training_sessions_organizer_id_fkey';
            columns: ['organizer_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'training_sessions_cancelled_by_fkey';
            columns: ['cancelled_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'training_sessions_activity_type_fkey';
            columns: ['activity_type'];
            isOneToOne: false;
            referencedRelation: 'activity_types';
            referencedColumns: ['key'];
          },
          {
            foreignKeyName: 'training_sessions_event_subtype_fkey';
            columns: ['event_kind', 'event_subtype'];
            isOneToOne: false;
            referencedRelation: 'event_subtypes';
            referencedColumns: ['kind', 'key'];
          },
          {
            foreignKeyName: 'training_sessions_attendance_finalized_by_fkey';
            columns: ['attendance_finalized_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      attendance_records: {
        Row: {
          id: string;
          session_id: string;
          community_id: string;
          /** G2: null once the member deleted their account (anonymous record, kept for session statistics). */
          user_id: string | null;
          status: Database['public']['Enums']['attendance_status'];
          recorded_by: string | null;
          recorded_at: string;
          updated_at: string;
          had_rsvp_going: boolean;
          is_walk_in: boolean;
        };
        Insert: {
          id?: string;
          session_id: string;
          community_id: string;
          user_id?: string | null;
          status?: Database['public']['Enums']['attendance_status'];
          recorded_by?: string | null;
          recorded_at?: string;
          updated_at?: string;
          had_rsvp_going: boolean;
          is_walk_in?: boolean;
        };
        Update: {
          id?: string;
          session_id?: string;
          community_id?: string;
          user_id?: string | null;
          status?: Database['public']['Enums']['attendance_status'];
          recorded_by?: string | null;
          recorded_at?: string;
          updated_at?: string;
          had_rsvp_going?: boolean;
          is_walk_in?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'attendance_records_session_fkey';
            columns: ['session_id', 'community_id'];
            isOneToOne: false;
            referencedRelation: 'training_sessions';
            referencedColumns: ['id', 'community_id'];
          },
          {
            foreignKeyName: 'attendance_records_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'attendance_records_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'attendance_records_recorded_by_fkey';
            columns: ['recorded_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      attendance_audit_log: {
        Row: {
          id: string;
          session_id: string;
          community_id: string;
          /** G2: null once the member deleted their account. */
          user_id: string | null;
          changed_by: string | null;
          changed_at: string;
          old_status: Database['public']['Enums']['attendance_status'];
          new_status: Database['public']['Enums']['attendance_status'];
          reason: string | null;
          action: AttendanceAuditAction;
        };
        Insert: {
          id?: string;
          session_id: string;
          community_id: string;
          user_id?: string | null;
          changed_by?: string | null;
          changed_at?: string;
          old_status: Database['public']['Enums']['attendance_status'];
          new_status: Database['public']['Enums']['attendance_status'];
          reason?: string | null;
          action: AttendanceAuditAction;
        };
        Update: {
          id?: string;
          session_id?: string;
          community_id?: string;
          user_id?: string | null;
          changed_by?: string | null;
          changed_at?: string;
          old_status?: Database['public']['Enums']['attendance_status'];
          new_status?: Database['public']['Enums']['attendance_status'];
          reason?: string | null;
          action?: AttendanceAuditAction;
        };
        Relationships: [
          {
            foreignKeyName: 'attendance_audit_log_session_fkey';
            columns: ['session_id', 'community_id'];
            isOneToOne: false;
            referencedRelation: 'training_sessions';
            referencedColumns: ['id', 'community_id'];
          },
          {
            foreignKeyName: 'attendance_audit_log_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'attendance_audit_log_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'attendance_audit_log_changed_by_fkey';
            columns: ['changed_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      training_rsvps: {
        Row: {
          id: string;
          session_id: string;
          community_id: string;
          user_id: string;
          response: Database['public']['Enums']['rsvp_response'];
          responded_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          community_id: string;
          user_id: string;
          response?: Database['public']['Enums']['rsvp_response'];
          responded_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          session_id?: string;
          community_id?: string;
          user_id?: string;
          response?: Database['public']['Enums']['rsvp_response'];
          responded_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'training_rsvps_session_fkey';
            columns: ['session_id', 'community_id'];
            isOneToOne: false;
            referencedRelation: 'training_sessions';
            referencedColumns: ['id', 'community_id'];
          },
          {
            foreignKeyName: 'training_rsvps_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'training_rsvps_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      announcements: {
        Row: {
          id: string;
          community_id: string;
          /** null once the author's account is deleted. */
          author_id: string | null;
          title: string;
          body: string;
          status: Database['public']['Enums']['announcement_status'];
          scheduled_for: string | null;
          published_at: string | null;
          cancelled_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          author_id?: string | null;
          title: string;
          body: string;
          status: Database['public']['Enums']['announcement_status'];
          scheduled_for?: string | null;
          published_at?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          author_id?: string | null;
          title?: string;
          body?: string;
          status?: Database['public']['Enums']['announcement_status'];
          scheduled_for?: string | null;
          published_at?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'announcements_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'announcements_author_id_fkey';
            columns: ['author_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      announcement_reads: {
        Row: { announcement_id: string; user_id: string; read_at: string };
        Insert: { announcement_id: string; user_id: string; read_at?: string };
        Update: { announcement_id?: string; user_id?: string; read_at?: string };
        Relationships: [
          {
            foreignKeyName: 'announcement_reads_announcement_id_fkey';
            columns: ['announcement_id'];
            isOneToOne: false;
            referencedRelation: 'announcements';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'announcement_reads_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      notifications: {
        Row: {
          id: string;
          /** No foreign key (see the contract); always the recipient. */
          user_id: string;
          community_id: string;
          kind: Database['public']['Enums']['notification_kind'];
          title: string;
          body: string;
          /** Relative app route: `/trainings/<id>` or `/announcements/<id>`. */
          deep_link: string;
          related_session_id: string | null;
          related_announcement_id: string | null;
          dedupe_key: string;
          created_at: string;
          read_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          community_id: string;
          kind: Database['public']['Enums']['notification_kind'];
          title: string;
          body: string;
          deep_link: string;
          related_session_id?: string | null;
          related_announcement_id?: string | null;
          dedupe_key: string;
          created_at?: string;
          read_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          community_id?: string;
          kind?: Database['public']['Enums']['notification_kind'];
          title?: string;
          body?: string;
          deep_link?: string;
          related_session_id?: string | null;
          related_announcement_id?: string | null;
          dedupe_key?: string;
          created_at?: string;
          read_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'notifications_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_related_session_id_fkey';
            columns: ['related_session_id'];
            isOneToOne: false;
            referencedRelation: 'training_sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_related_announcement_id_fkey';
            columns: ['related_announcement_id'];
            isOneToOne: false;
            referencedRelation: 'announcements';
            referencedColumns: ['id'];
          },
        ];
      };
      /** No client access at all (no grant, no policy). Listed for the service-role dispatcher. */
      notification_delivery_jobs: {
        Row: {
          id: string;
          notification_id: string;
          user_id: string;
          status: NotificationJobStatus;
          attempts: number;
          max_attempts: number;
          next_attempt_at: string;
          expires_at: string;
          last_error: string | null;
          locked_at: string | null;
          locked_by: string | null;
          created_at: string;
          sent_at: string | null;
        };
        Insert: {
          id?: string;
          notification_id: string;
          user_id: string;
          status?: NotificationJobStatus;
          attempts?: number;
          max_attempts?: number;
          next_attempt_at?: string;
          expires_at: string;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          created_at?: string;
          sent_at?: string | null;
        };
        Update: {
          id?: string;
          notification_id?: string;
          user_id?: string;
          status?: NotificationJobStatus;
          attempts?: number;
          max_attempts?: number;
          next_attempt_at?: string;
          expires_at?: string;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          created_at?: string;
          sent_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_delivery_jobs_notification_id_fkey';
            columns: ['notification_id'];
            isOneToOne: true;
            referencedRelation: 'notifications';
            referencedColumns: ['id'];
          },
        ];
      };
      device_push_tokens: {
        Row: {
          id: string;
          user_id: string;
          token: string;
          platform: PushPlatform;
          device_label: string | null;
          created_at: string;
          last_seen_at: string;
          invalidated_at: string | null;
          last_error: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          token: string;
          platform: PushPlatform;
          device_label?: string | null;
          created_at?: string;
          last_seen_at?: string;
          invalidated_at?: string | null;
          last_error?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          token?: string;
          platform?: PushPlatform;
          device_label?: string | null;
          created_at?: string;
          last_seen_at?: string;
          invalidated_at?: string | null;
          last_error?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'device_push_tokens_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      // GDPR G1. Select-only; no client writes.
      legal_documents: {
        Row: { document: LegalDocumentKind; version: string; effective_at: string; updated_at: string };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /** Append-only ledger; a user reads only their own rows. Write through record_consent / withdraw_consent. */
      consent_records: {
        Row: {
          id: string;
          user_id: string;
          purpose: ConsentPurpose;
          document_version: string | null;
          granted: boolean;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      notification_preferences: {
        Row: {
          user_id: string;
          push_enabled: boolean;
          training_reminders: boolean;
          announcements: boolean;
          training_updates: boolean;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          push_enabled?: boolean;
          training_reminders?: boolean;
          announcements?: boolean;
          training_updates?: boolean;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          push_enabled?: boolean;
          training_reminders?: boolean;
          announcements?: boolean;
          training_updates?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_preferences_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      /**
       * P4: event feed. Organizer top-level posts (`parent_id` null) and member replies (one
       * level). Readable by active members of the community. Write only through the RPCs.
       */
      event_posts: {
        Row: {
          id: string;
          session_id: string;
          community_id: string;
          /** null once the author deleted their account ("Former member"). */
          author_id: string | null;
          parent_id: string | null;
          /** null exactly when the post is deleted. */
          body: string | null;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'event_posts_session_fkey';
            columns: ['session_id', 'community_id'];
            isOneToOne: false;
            referencedRelation: 'training_sessions';
            referencedColumns: ['id', 'community_id'];
          },
          {
            foreignKeyName: 'event_posts_author_id_fkey';
            columns: ['author_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'event_posts_parent_fkey';
            columns: ['parent_id', 'session_id'];
            isOneToOne: false;
            referencedRelation: 'event_posts';
            referencedColumns: ['id', 'session_id'];
          },
        ];
      };
      /** P4: the caller's read cursor per event (own rows only). Written by `mark_event_feed_read`. */
      event_feed_reads: {
        Row: { session_id: string; user_id: string; last_read_at: string };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'event_feed_reads_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'training_sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'event_feed_reads_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      is_active_member: {
        Args: { community_id: string };
        Returns: boolean;
      };
      is_organizer: {
        Args: { community_id: string };
        Returns: boolean;
      };
      preview_invitation: {
        Args: { p_code: string };
        Returns: Json;
      };
      redeem_invitation: {
        Args: { p_code: string; p_display_name: string };
        Returns: Json;
      };
      create_invitation: {
        Args: {
          p_community_id: string;
          p_expires_at?: string | null;
          p_max_redemptions?: number | null;
        };
        Returns: Database['public']['Tables']['invitation_codes']['Row'];
      };
      revoke_invitation: {
        Args: { p_invitation_id: string };
        Returns: Database['public']['Tables']['invitation_codes']['Row'];
      };
      /** service_role only. */
      admin_create_community: {
        Args: { p_name: string; p_timezone: string };
        Returns: Json;
      };
      update_display_name: {
        Args: { p_display_name: string };
        Returns: Database['public']['Tables']['profiles']['Row'];
      };
      // C1: creator codes and community management.
      /** service_role only (or `postgres` in the SQL editor). Returns an `AdminCreateCreatorCodeResult`. */
      admin_create_creator_code: {
        Args: { p_note?: string | null; p_expires_in_days?: number; p_max_uses?: number };
        Returns: Json;
      };
      /** service_role only (or `postgres` in the SQL editor); idempotent. Returns an `AdminRevokeCreatorCodeResult`. */
      admin_revoke_creator_code: {
        Args: { p_code: string };
        Returns: Json;
      };
      /** Returns a `PreviewCreatorCodeResult`. Counts toward the shared code-attempt limit. */
      preview_creator_code: {
        Args: { p_code: string };
        Returns: Json;
      };
      /**
       * Returns a `CreateCommunityWithCodeResult`. `p_request_id` is a client-generated idempotency
       * key: generate one per form submission and reuse it for retries of that submission.
       */
      create_community_with_code: {
        Args: {
          p_code: string;
          p_name: string;
          p_timezone: string;
          p_display_name: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      /** Organizer of the community only. */
      update_community: {
        /** C3: pass the row's updated_at as p_expected_updated_at to get stale_data instead of overwriting a newer save. */
        Args: { p_community_id: string; p_name: string; p_timezone: string; p_expected_updated_at?: string | null };
        Returns: Database['public']['Tables']['communities']['Row'];
      };
      /** Returns `MyCommunity[]`: the caller's active memberships, oldest first. */
      list_my_communities: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      create_training: {
        Args: { p_community_id: string; p_input: Json };
        Returns: Database['public']['Tables']['training_sessions']['Row'];
      };
      update_training: {
        Args: { p_session_id: string; p_input: Json };
        Returns: Database['public']['Tables']['training_sessions']['Row'];
      };
      cancel_training: {
        Args: { p_session_id: string; p_reason?: string | null };
        Returns: Database['public']['Tables']['training_sessions']['Row'];
      };
      set_rsvp: {
        Args: {
          p_session_id: string;
          p_response: Database['public']['Enums']['rsvp_response'];
        };
        Returns: Json;
      };
      /** service_role only; scheduled by pg_cron. */
      finalize_due_sessions: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      /** Organizer only. `p_user_id` is the attendee, not the caller. */
      record_attendance: {
        Args: {
          p_session_id: string;
          p_user_id: string;
          p_status: Database['public']['Enums']['attendance_status'];
          p_reason?: string | null;
        };
        Returns: Database['public']['Tables']['attendance_records']['Row'];
      };
      /** Organizer only. `p_user_id` is the attendee, not the caller. */
      add_walk_in_attendee: {
        Args: { p_session_id: string; p_user_id: string };
        Returns: Database['public']['Tables']['attendance_records']['Row'];
      };
      /** Organizer only. */
      finalize_attendance: {
        Args: { p_session_id: string };
        Returns: Database['public']['Tables']['training_sessions']['Row'];
      };
      /** Organizer only. Returns an `AttendanceSheet`. */
      get_attendance_sheet: {
        Args: { p_session_id: string };
        Returns: Json;
      };
      /** Organizer only. `p_scheduled_for` null = publish now. */
      create_announcement: {
        Args: {
          p_community_id: string;
          p_title: string;
          p_body: string;
          p_scheduled_for?: string | null;
        };
        Returns: Database['public']['Tables']['announcements']['Row'];
      };
      /** Organizer only, while `scheduled`. `p_scheduled_for` null = publish now. */
      update_announcement: {
        Args: { p_id: string; p_title: string; p_body: string; p_scheduled_for: string | null };
        Returns: Database['public']['Tables']['announcements']['Row'];
      };
      /** Organizer only, while `scheduled`; idempotent. */
      cancel_announcement: {
        Args: { p_id: string };
        Returns: Database['public']['Tables']['announcements']['Row'];
      };
      /** service_role only; scheduled by pg_cron. */
      publish_due_announcements: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      mark_announcement_read: {
        Args: { p_id: string };
        Returns: Database['public']['Tables']['announcement_reads']['Row'];
      };
      /** Returns the number of announcements newly marked read. */
      mark_announcements_read: {
        Args: { p_community_id: string };
        Returns: number;
      };
      unread_announcement_count: {
        Args: { p_community_id: string };
        Returns: number;
      };
      mark_notification_read: {
        Args: { p_id: string };
        Returns: Database['public']['Tables']['notifications']['Row'];
      };
      /** Returns the number of notifications newly marked read. */
      mark_all_notifications_read: {
        Args: { p_community_id: string };
        Returns: number;
      };
      /** service_role only; scheduled by pg_cron. */
      enqueue_due_training_reminders: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      register_push_token: {
        Args: { p_token: string; p_platform: PushPlatform; p_device_label?: string | null };
        Returns: Database['public']['Tables']['device_push_tokens']['Row'];
      };
      /** Returns whether a row was removed. */
      unregister_push_token: {
        Args: { p_token: string };
        Returns: boolean;
      };
      /** `updated_at` is null when the user never saved preferences (all defaults). */
      get_notification_preferences: {
        Args: Record<PropertyKey, never>;
        Returns: Omit<Database['public']['Tables']['notification_preferences']['Row'], 'updated_at'> & {
          updated_at: string | null;
        };
      };
      /** A null / omitted argument keeps the current value. */
      set_notification_preferences: {
        Args: {
          p_push_enabled?: boolean | null;
          p_training_reminders?: boolean | null;
          p_announcements?: boolean | null;
          p_training_updates?: boolean | null;
        };
        Returns: Database['public']['Tables']['notification_preferences']['Row'];
      };
      /** service_role only (push dispatcher). Returns one `ClaimedNotificationJob` per row. */
      claim_notification_jobs: {
        Args: { p_limit?: number; p_worker: string };
        Returns: Json[];
      };
      /** service_role only (push dispatcher). Returns a `CompleteNotificationJobResult`. */
      complete_notification_job: {
        Args: {
          p_job_id: string;
          p_status: NotificationJobOutcome;
          p_error?: string | null;
          p_retry_in_seconds?: number | null;
        };
        Returns: Json;
      };
      /** service_role only (push dispatcher). Returns the number of tokens newly invalidated. */
      invalidate_push_tokens: {
        Args: { p_tokens: string[]; p_error?: string | null };
        Returns: number;
      };
      /** service_role only; scheduled daily. Returns the number of rows deleted. */
      purge_old_notification_data: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      // GDPR G1: legal versions and consents.
      /** service_role only (or `postgres` in the SQL editor). Returns an `AdminSetLegalVersionResult`. */
      admin_set_legal_version: {
        Args: { p_document: LegalDocumentKind; p_version: string };
        Returns: Json;
      };
      /**
       * Appends a grant. For `terms_privacy`, `p_document_version` must be `MyConsents.terms_privacy_version`
       * exactly. Other purposes (P3-QA-7): pass the privacy version the app SHOWED (its bundled
       * privacy version); the server refuses one that is not the version in force with
       * `validation_failed:document_version` (map to `app_update_required`, as for terms_privacy);
       * null / omitted stamps the version in force (older builds).
       * Returns a `ConsentEvent`. Raises `validation_failed:purpose`,
       * `validation_failed:document_version`, `rate_limited`, `not_authenticated`.
       */
      record_consent: {
        Args: { p_purpose: ConsentPurpose; p_document_version?: string | null };
        Returns: Json;
      };
      /** Appends a withdrawal. Returns a `ConsentEvent`. Raises `not_withdrawable` for terms_privacy / age_16. */
      withdraw_consent: {
        Args: { p_purpose: ConsentPurpose };
        Returns: Json;
      };
      /** Returns `MyConsents`. */
      my_consents: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      // GDPR G2: role management, export and deletion.
      /**
       * Active organizer only. `p_user_id` is the target (an active member, not the caller).
       * Raises `forbidden`, `validation_failed:user_id`, `validation_failed:role`,
       * `cannot_change_own_role`, `not_found`, `last_organizer`. Same role again: unchanged row.
       */
      set_member_role: {
        Args: {
          p_community_id: string;
          p_user_id: string;
          p_role: Database['public']['Enums']['membership_role'];
        };
        Returns: Database['public']['Tables']['memberships']['Row'];
      };
      /**
       * Active organizer only; sets the target's status to `removed` (idempotent). Raises `forbidden`,
       * `validation_failed:user_id`, `cannot_remove_self`, `not_found`, `last_organizer`.
       */
      remove_member: {
        Args: { p_community_id: string; p_user_id: string };
        Returns: Database['public']['Tables']['memberships']['Row'];
      };
      /** Returns a `LeaveCommunityResult`. Raises `not_a_member`, `last_organizer`. */
      leave_community: {
        Args: { p_community_id: string };
        Returns: Json;
      };
      /** Returns a `MyDataExport`. Raises `rate_limited` (10 per hour), `not_authenticated`. */
      export_my_data: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /** Returns `MyDeletionBlockers`. Raises `not_authenticated`. */
      my_deletion_blockers: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /**
       * Deletes the caller's account. Returns a `DeleteMyAccountResult`. Raises `not_authenticated`
       * (also on a second call) and `last_organizer` (error `details`: `DeletionBlockedDetail` as JSON).
       */
      delete_my_account: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      // Milestone 4: statistics (read-only, authenticated). Definitions: docs/STATS_DEFINITIONS.md.
      /** Active member of the community. Returns a `MyStatistics`. */
      get_my_statistics: {
        Args: { p_community_id: string; p_window: StatisticsWindow };
        Returns: Json;
      };
      /** Active member of the community. Returns an `AttendanceHistoryPage` (limit 1–100, default 50). */
      get_my_attendance_history: {
        Args: {
          p_community_id: string;
          p_window: StatisticsWindow;
          p_limit?: number;
          /** `next_before` of the previous page, passed back verbatim. */
          p_before?: string | null;
        };
        Returns: Json;
      };
      /** Organizer of the community; the member may be removed. Returns a `MemberStatistics`. */
      get_member_statistics: {
        Args: { p_community_id: string; p_user_id: string; p_window: StatisticsWindow };
        Returns: Json;
      };
      /**
       * Organizer of the community; the member may be removed (else `not_found`). Returns an
       * `AttendanceHistoryPage`, same behaviour as `get_my_attendance_history`.
       */
      get_member_attendance_history: {
        Args: {
          p_community_id: string;
          p_user_id: string;
          p_window: StatisticsWindow;
          p_limit?: number;
          p_before?: string | null;
        };
        Returns: Json;
      };
      /** Organizer of the community. Returns a `CommunityStatistics`. */
      get_community_statistics: {
        Args: { p_community_id: string; p_window: StatisticsWindow };
        Returns: Json;
      };
      /** Organizer of the community. Returns a `MemberStatisticsSummary` (active members, at most 500). */
      list_member_statistics_summary: {
        Args: { p_community_id: string; p_window: StatisticsWindow };
        Returns: Json;
      };
      // P4: event feed.
      /**
       * Active organizer of the event's community; top-level post. Raises `not_authenticated`,
       * `not_found`, `forbidden`, `event_closed` (30 days after the event's end),
       * `validation_failed:body` (1..1000 after cleaning), `rate_limited` (5 posts per organizer
       * per event per rolling hour; nothing written).
       */
      create_event_post: {
        Args: { p_session_id: string; p_body: string };
        Returns: Database['public']['Tables']['event_posts']['Row'];
      };
      /**
       * Active member; reply to a top-level, not deleted post. Raises `not_authenticated`,
       * `not_found`, `not_a_member`, `not_a_top_level_post`, `post_deleted`, `event_closed`,
       * `validation_failed:body`.
       */
      reply_to_event_post: {
        Args: { p_post_id: string; p_body: string };
        Returns: Database['public']['Tables']['event_posts']['Row'];
      };
      /**
       * Soft delete (body cleared), a top-level post takes its replies. Active organizers: any
       * post; the author (active member): own replies only. Idempotent; allowed after the feed
       * closed. Raises `not_authenticated`, `not_found`, `forbidden`.
       */
      delete_event_post: {
        Args: { p_post_id: string };
        Returns: Database['public']['Tables']['event_posts']['Row'];
      };
      /** Active member; moves the caller's cursor to now. Raises `not_authenticated`, `not_found`, `not_a_member`. */
      mark_event_feed_read: {
        Args: { p_session_id: string };
        Returns: Database['public']['Tables']['event_feed_reads']['Row'];
      };
      /** Active member. Returns an `EventFeed`. Raises `not_authenticated`, `not_found`, `not_a_member`. */
      get_event_feed: {
        Args: { p_session_id: string };
        Returns: Json;
      };
      /** Active member. Returns `EventFeedUnread[]`. Raises `not_authenticated`, `not_a_member`. */
      get_event_feed_unread: {
        Args: { p_community_id: string };
        Returns: Json;
      };
      /** P3: the caller's own details. Returns an `AboutYou`. Raises `not_authenticated`. */
      get_my_about_you: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /**
       * P3: partial update (`AboutYouInput`: absent key = unchanged, null = clear). Returns an
       * `AboutYou`. Raises `not_authenticated`, `validation_failed:input` / `validation_failed:<field>`,
       * `not_a_member` (no profile), `consent_required:profile_demographics`,
       * `consent_required:emergency_contact`.
       */
      save_my_about_you: {
        Args: { p_input: Json };
        Returns: Json;
      };
      /** P3: deletes all the caller's details (consents unchanged). Returns `AboutYou & { cleared }`. */
      clear_my_about_you: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /**
       * P3: active organizer of the community; target an active member. Returns a
       * `MemberEmergencyInfo`. Raises `not_authenticated`, `forbidden`, `validation_failed:user_id`,
       * `not_found`.
       */
      get_member_emergency_info: {
        Args: { p_community_id: string; p_user_id: string };
        Returns: Json;
      };
      /** P3: active organizer. Returns a `CommunityEmergencyList` (cap 500). Raises `not_authenticated`, `forbidden`. */
      list_community_emergency_info: {
        Args: { p_community_id: string };
        Returns: Json;
      };
      /**
       * P3: active organizer. Returns `CommunityDemographics` (approximate: nothing below 20
       * members with data, cells < 5 suppressed, shown cells rounded to 5). Raises
       * `not_authenticated`, `forbidden`.
       */
      get_community_demographics: {
        Args: { p_community_id: string };
        Returns: Json;
      };
      /**
       * P5: create or replace the caller's log of an event (`WorkoutLogInput` by the event's log
       * type). Returns a `WorkoutLog`. Raises `not_authenticated`, `validation_failed:input`,
       * `not_found`, `not_a_member`, `not_loggable`, `event_not_ended`, `not_eligible`,
       * `validation_failed:<field>`, `consent_required:workout_logs`.
       */
      save_workout_log: {
        Args: { p_session_id: string; p_input: Json };
        Returns: Json;
      };
      /** P5: the log screen context. Returns a `WorkoutLogScreen`. Raises `not_authenticated`, `not_found`, `not_a_member`. */
      get_my_workout_log: {
        Args: { p_session_id: string };
        Returns: Json;
      };
      /** P5: deletes the caller's log of an event. Returns `DeleteWorkoutLogResult`. Raises `not_authenticated`. */
      delete_my_workout_log: {
        Args: { p_session_id: string };
        Returns: Json;
      };
      /** P5: the caller's logs, newest event first. Returns `WorkoutLogPage`. Raises `not_authenticated`, `validation_failed:limit`. */
      list_my_workout_logs: {
        Args: { p_limit?: number; p_before?: string | null };
        Returns: Json;
      };
      /** P5: the caller's totals. Returns `MyWorkoutStats`. Raises `not_authenticated`, `validation_failed:range`. */
      get_my_workout_stats: {
        Args: { p_community_id?: string | null; p_from?: string | null; p_to?: string | null };
        Returns: Json;
      };
      /**
       * P5: active organizer. Returns `CommunityWorkoutStats` (approximate: nothing below 20
       * contributing members, never differenceable with a smaller window, rounded totals).
       * Raises `not_authenticated`, `forbidden`, `validation_failed:window`.
       */
      get_community_workout_stats: {
        Args: { p_community_id: string; p_window?: StatisticsWindow };
        Returns: Json;
      };
      /** P5: service_role / pg_cron every minute. Returns the number of prompts inserted. */
      enqueue_workout_log_prompts: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      // GDPR G3: retention of inactive accounts.
      /**
       * G3: call on app start and on return to the foreground (signed in). Records that the app
       * was opened (at most one write per hour) and ends a pending inactivity notice. Returns an
       * `AppOpenResult`; show `notice` once when it is not null. Raises `not_authenticated`.
       */
      record_app_open: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /** G3: service_role only. Dry run, counts only. Returns a `RetentionPreview`. */
      retention_preview: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /** G3: service_role / pg_cron daily. Returns a `RetentionRunResult`. Does nothing while disabled. */
      run_account_retention: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /** G3: service_role only (the kill switch). Returns a `RetentionSwitchResult`. Raises `validation_failed:enabled`. */
      admin_set_retention_enabled: {
        Args: { p_enabled: boolean };
        Returns: Json;
      };
    };
    Enums: {
      membership_role: 'organizer' | 'member';
      membership_status: 'active' | 'removed';
      session_status: 'scheduled' | 'confirmed' | 'cancelled' | 'completed';
      /** P1: the kind of an event (a row of training_sessions). */
      event_kind: 'training' | 'race' | 'sports_event' | 'social';
      cancel_reason: 'insufficient_participation' | 'organizer';
      rsvp_response: 'going' | 'not_going' | 'no_response';
      attendance_status: 'present' | 'absent' | 'unrecorded';
      announcement_status: 'scheduled' | 'published' | 'cancelled';
      notification_kind:
        | 'training_created'
        | 'training_updated'
        | 'training_confirmed'
        | 'training_cancelled'
        | 'training_reminder'
        | 'announcement_published'
        /** P4: a new organizer post (to members going to the event). */
        | 'event_post'
        /** P4: a reply to the recipient's post. */
        | 'event_reply'
        /** P5: "How did it go? Log your workout." after an event (deep link /events/<id>/log). */
        | 'workout_log_prompt';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

// ---------------------------------------------------------------------------
// Convenience aliases (keep this section when swapping in generated types)
// ---------------------------------------------------------------------------

type PublicSchema = Database['public'];

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];
export type FunctionArgs<T extends keyof PublicSchema['Functions']> =
  PublicSchema['Functions'][T]['Args'];
export type FunctionReturns<T extends keyof PublicSchema['Functions']> =
  PublicSchema['Functions'][T]['Returns'];

export type Community = Tables<'communities'>;
export type Profile = Tables<'profiles'>;
export type Membership = Tables<'memberships'>;
export type InvitationCode = Tables<'invitation_codes'>;
export type InvitationRedemption = Tables<'invitation_redemptions'>;
export type ActivityType = Tables<'activity_types'>;
export type TrainingSession = Tables<'training_sessions'>;
export type TrainingRsvp = Tables<'training_rsvps'>;
export type AttendanceRecord = Tables<'attendance_records'>;
export type AttendanceAuditEntry = Tables<'attendance_audit_log'>;

export type MembershipRole = Enums<'membership_role'>;
export type MembershipStatus = Enums<'membership_status'>;
export type SessionStatus = Enums<'session_status'>;
/** P1: training | race | sports_event | social. "Event" is UI vocabulary for a training_sessions row. */
export type EventKind = Enums<'event_kind'>;
/** P1: a row of the event_subtypes lookup. */
export type EventSubtype = Tables<'event_subtypes'>;
/** P1: an event is a training_sessions row (the table keeps its name). */
export type EventSession = TrainingSession;
export type CancelReason = Enums<'cancel_reason'>;
export type RsvpResponse = Enums<'rsvp_response'>;
export type AttendanceStatus = Enums<'attendance_status'>;

export type Announcement = Tables<'announcements'>;
export type AnnouncementRead = Tables<'announcement_reads'>;
export type AppNotification = Tables<'notifications'>;
export type DevicePushToken = Tables<'device_push_tokens'>;
export type NotificationPreferences = Tables<'notification_preferences'>;
export type NotificationDeliveryJob = Tables<'notification_delivery_jobs'>;
export type AnnouncementStatus = Enums<'announcement_status'>;
export type NotificationKind = Enums<'notification_kind'>;

/** P4: a row of `event_posts`. */
export type EventPost = Tables<'event_posts'>;
/** P4: a row of `event_feed_reads`. */
export type EventFeedRead = Tables<'event_feed_reads'>;

/** P4: one post or reply in `get_event_feed`. */
export type EventFeedItem = {
  id: string;
  parent_id: string | null;
  /** null for a deleted account: show "Former member". */
  author_id: string | null;
  author_name: string | null;
  /** The author's current active role in the community, else null. */
  author_role: MembershipRole | null;
  body: string;
  created_at: string;
  /** Not written by the caller and created after the caller's cursor. */
  is_unread: boolean;
  /** The caller may delete it: organizers any post, authors their own replies. */
  can_delete: boolean;
};

/** P4: result of `get_event_feed`. Top-level posts newest first, replies oldest first; deleted ones left out. */
export type EventFeed = {
  session_id: string;
  community_id: string;
  /** The caller is an active organizer (may delete any post). */
  is_organizer: boolean;
  /** Posts and replies are accepted until then (30 days after the event's end). */
  closes_at: string;
  is_open: boolean;
  /** is_organizer and is_open. */
  can_post: boolean;
  /** is_open (every active member may reply). */
  can_reply: boolean;
  last_read_at: string | null;
  /** Posts plus replies. */
  post_count: number;
  unread_count: number;
  posts: (EventFeedItem & { parent_id: null; replies: EventFeedItem[] })[];
};

/** P4: one row of `get_event_feed_unread` (events of the community with visible posts). */
export type EventFeedUnread = {
  session_id: string;
  post_count: number;
  unread_count: number;
  last_post_at: string;
};

/** P3: gender choices on the About-you page. */
export type AboutYouGender = 'woman' | 'man' | 'prefer_not_to_say';

/** P3: T-shirt sizes (stored upper case; the server accepts any case). */
export type TshirtSize = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL';

/**
 * P3: input of `save_my_about_you`. Partial update: a key that is absent leaves the field
 * unchanged, `null` clears it. Unknown keys are refused (`validation_failed:input`).
 */
export type AboutYouInput = {
  /** Integer between `birth_year_min` and `birth_year_max` of `AboutYou` (server year - 100 .. - 16). Needs `profile_demographics` consent. */
  birth_year?: number | null;
  /** Needs `profile_demographics` consent. */
  gender?: AboutYouGender | null;
  /** 1-80 characters after text hygiene. Needs `emergency_contact` consent; a contact needs name + phone. */
  emergency_contact_name?: string | null;
  /** Digits, spaces, + ( ) . / -; 6-20 digits; at most 30 characters. Needs `emergency_contact` consent. */
  emergency_contact_phone?: string | null;
  /** Optional, 1-40 characters. Needs `emergency_contact` consent. */
  emergency_contact_relationship?: string | null;
  /** Needs `emergency_contact` consent (withdrawing it deletes the size too). */
  tshirt_size?: TshirtSize | Lowercase<TshirtSize> | null;
};

/** P3: result of `get_my_about_you` / `save_my_about_you` (and `clear_my_about_you`, plus `cleared`). */
export type AboutYou = {
  has_data: boolean;
  birth_year: number | null;
  gender: AboutYouGender | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  tshirt_size: TshirtSize | null;
  /** null when nothing is stored. */
  updated_at: string | null;
  /** Allowed birth-year range from the server's clock (use these, not the device clock). */
  birth_year_min: number;
  birth_year_max: number;
  /** Whether the consent each part needs is current. */
  consents: { profile_demographics: boolean; emergency_contact: boolean };
};

/** P3: result of `clear_my_about_you`. `cleared` is false when nothing was stored. */
export type ClearAboutYouResult = AboutYou & { cleared: boolean };

/** P3: what an organizer sees of one active member (never birth year or gender). */
export type MemberEmergencyInfo = {
  /** Only in `get_member_emergency_info`. */
  community_id?: string;
  user_id: string;
  display_name: string;
  role: MembershipRole;
  /** The three contact fields are null unless `has_emergency_contact`; all four are null without a current `emergency_contact` consent. */
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  tshirt_size: TshirtSize | null;
  has_emergency_contact: boolean;
  /** null when the member stored nothing. */
  updated_at: string | null;
};

/** P3: result of `list_community_emergency_info`: members with a contact or a T-shirt size, by name, at most 500. */
export type CommunityEmergencyList = {
  community_id: string;
  members: MemberEmergencyInfo[];
  truncated: boolean;
};

/**
 * P3: one cell of `get_community_demographics`. `count` is null when suppressed; a shown count is
 * APPROXIMATE: the real count rounded to a multiple of `rounded_to` (5), so at least 5 and within 2
 * of the real count.
 */
export type DemographicsCell<K extends string> = { key: K; count: number | null; suppressed: boolean };

export type AgeBand = 'under_18' | '18_29' | '30_39' | '40_49' | '50_59' | '60_plus' | 'not_provided';

/**
 * P3: result of `get_community_demographics` over the community's active members (approximate
 * group totals, P3-QA-1). Per dimension: when fewer than `min_members_with_data` (20) members gave
 * a value, every cell is suppressed and `insufficient_data[dimension]` is true; otherwise cells
 * whose real count is below `min_group_size` (5) are suppressed, with complementary suppression
 * (suppressed cells are at least two and hold 5 or more people, or every cell is suppressed), and
 * shown cells are rounded to `rounded_to` (5). No age x gender cross-table.
 */
export type CommunityDemographics = {
  community_id: string;
  min_group_size: number;
  /** Members with a value (not `not_provided`) a dimension needs before any cell is shown: 20. */
  min_members_with_data: number;
  /** Shown counts are rounded to a multiple of this: 5. */
  rounded_to: number;
  /** Exact number of active members (the population). */
  member_count: number;
  /** Server year used for ages (age = reference_year - birth year). */
  reference_year: number;
  /** True for a dimension with too few members with data: all its cells are suppressed. */
  insufficient_data: { age_bands: boolean; genders: boolean };
  age_bands: DemographicsCell<AgeBand>[];
  genders: DemographicsCell<AboutYouGender | 'not_provided'>[];
};

/**
 * P5: the shape of a workout log, derived from the event (never chosen by the client): `race` for
 * race events; `running` for running / trail_running / ocr activities; `strength` for strength /
 * functional_fitness activities (CrossFit events included). Other events are not loggable.
 */
export type WorkoutLogType = 'strength' | 'running' | 'race';

/** P5: one set of a strength exercise. `weight_kg` 0..1000 in steps of 0.25 (0 = bodyweight). */
export type WorkoutSet = { reps: number; weight_kg: number };

/** P5: one exercise of a strength log (name 1..80 after text hygiene, 1..20 sets). */
export type WorkoutExercise = { name: string; sets: WorkoutSet[] };

/**
 * P5: input of `save_workout_log` (replaces the whole log; unknown keys refused with
 * `validation_failed:input`). Notes: at most 1000 characters after text hygiene; blank = none.
 */
export type WorkoutLogInput =
  /** strength: at most 30 exercises; at least one exercise or a note. `weight_kg` absent/null = 0. */
  | { exercises?: { name: string; sets: { reps: number; weight_kg?: number | null }[] }[] | null; notes?: string | null }
  /**
   * running: at least distance_m or duration_s. race: duration_s (finish time) required. With both,
   * the pace must lie in 1:00..30:00 min/km (60..1800 s/km), else `validation_failed:duration_s`.
   */
  | { distance_m?: number | null; duration_s?: number | null; notes?: string | null };

/** P5: a stored log (result of `save_workout_log`, items of `list_my_workout_logs`). Owner only. */
export type WorkoutLog = {
  id: string;
  session_id: string;
  community_id: string;
  log_type: WorkoutLogType;
  /** Snapshot of the event when the log was last saved (the log outlives a deleted event). */
  event_title: string;
  event_starts_at: string;
  event_kind: EventKind;
  event_subtype: string;
  /** running / race: metres (1..1 000 000). */
  distance_m: number | null;
  /** running / race: seconds (1..604 800); for a race the finish time. */
  duration_s: number | null;
  /** Computed by the database: round(duration_s / km), null unless both are known. */
  pace_s_per_km: number | null;
  /** strength only (possibly empty when only a note was saved). */
  exercises: WorkoutExercise[] | null;
  /** strength only: sum of reps x weight_kg. */
  strength_volume_kg: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/** P5: why the caller cannot log an event now (`get_my_workout_log`). */
export type WorkoutLogBlockReason = 'not_a_member' | 'not_loggable' | 'event_not_ended' | 'not_eligible' | 'not_found';

/** P5: result of `get_my_workout_log`: everything the log screen needs. */
export type WorkoutLogScreen = {
  session_id: string;
  community_id: string;
  /**
   * null when the event no longer exists (its community was deleted) or when the caller is not an
   * active member of its community (left / removed: only the log's own snapshot is shown).
   */
  event: {
    title: string;
    starts_at: string;
    ends_at: string | null;
    event_kind: EventKind;
    event_subtype: string;
    /** The event's course distance, to prefill the form. */
    distance_km: number | null;
    status: SessionStatus;
  } | null;
  /** null when the event is not loggable. */
  log_type: WorkoutLogType | null;
  can_log: boolean;
  cannot_log_reason: WorkoutLogBlockReason | null;
  /** Whether the caller holds a current `workout_logs` consent (needed to save). */
  has_consent: boolean;
  log: WorkoutLog | null;
};

/** P5: result of `delete_my_workout_log` (`deleted` false when there was no log). */
export type DeleteWorkoutLogResult = { session_id: string; deleted: boolean };

/** P5: result of `list_my_workout_logs`; pass `next_before` as `p_before` for the next page. */
export type WorkoutLogPage = { logs: WorkoutLog[]; next_before: string | null };

/** P5: result of `get_my_workout_stats` (docs/STATS_DEFINITIONS.md, "Workout statistics (P5)"). */
export type MyWorkoutStats = {
  community_id: string | null;
  from: string | null;
  to: string | null;
  sessions_logged: number;
  running_sessions: number;
  race_sessions: number;
  strength_sessions: number;
  total_distance_m: number;
  total_duration_s: number;
  /** Total time / total distance over logs that have both; null when none. */
  average_pace_s_per_km: number | null;
  pace_sessions: number;
  strength_volume_kg: number;
  strength_sets: number;
};

/**
 * P5: result of `get_community_workout_stats` (organizers only). APPROXIMATE: every metric is null
 * (`insufficient_data`) while fewer than `min_contributors` (20) members logged in the window, or
 * when the window differs from the next smaller published window by 1..19 members (nested-window
 * rule); each metric also needs 20 contributors of its own (and the same band rule). Shown values
 * are rounded (members and sessions to 5, distance to 10 km, time to 30 minutes, pace to 10 s/km).
 */
export type CommunityWorkoutStats = {
  community_id: string;
  window: StatisticsWindow;
  from: string | null;
  to: string;
  min_contributors: number;
  insufficient_data: boolean;
  members_contributing: number | null;
  sessions_logged: number | null;
  total_distance_km: number | null;
  total_duration_minutes: number | null;
  average_pace_s_per_km: number | null;
};

/** Why a claimed job has no tokens (`claim_notification_jobs`; first match wins, in this order). */
export type NotificationSkipReason =
  | 'not_a_member'
  | 'push_disabled'
  | 'category_disabled'
  | 'no_push_consent'
  | 'no_tokens';

/** One row of `claim_notification_jobs` (service_role dispatcher). */
export type ClaimedNotificationJob = {
  job_id: string;
  notification_id: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  deep_link: string;
  community_id: string;
  related_session_id: string | null;
  related_announcement_id: string | null;
  /** Including this claim. */
  attempts: number;
  max_attempts: number;
  /** The recipient's unread in-app notifications (all communities), for the badge. */
  unread_count: number;
  push_allowed: boolean;
  skip_reason: NotificationSkipReason | null;
  /** Valid tokens, most recently seen first; empty when push is not allowed. */
  tokens: string[];
};

/** Result of `complete_notification_job`. `changed` is false for a repeated completion. */
export type CompleteNotificationJobResult = {
  job_id: string;
  status: NotificationJobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  sent_at: string | null;
  changed: boolean;
};

/** `{ ok: false, error }` branch shared by the invitation RPCs. `error` is a contract code. */
export type RpcFailure = { ok: false; error: string };

/** Result of `preview_invitation`. */
export type PreviewInvitationResult =
  | { ok: true; community_name: string; role: MembershipRole }
  | RpcFailure;

/** Result of `redeem_invitation`. */
export type RedeemInvitationResult =
  | {
      ok: true;
      community_id: string;
      membership_id: string;
      role: MembershipRole;
      already_member: boolean;
    }
  | RpcFailure;

/** Result of `admin_create_community` (service_role only). */
export type AdminCreateCommunityResult = { community_id: string; organizer_code: string };

/** Error codes of `preview_creator_code`. */
export type CreatorCodeError =
  | 'invalid_code'
  | 'expired'
  | 'revoked'
  | 'exhausted'
  | 'rate_limited'
  | 'not_authenticated';

/** Error codes of `create_community_with_code`. */
export type CreateCommunityWithCodeError =
  | CreatorCodeError
  | 'community_limit_reached'
  | 'validation_failed:name'
  | 'validation_failed:timezone'
  | 'validation_failed:display_name'
  | 'validation_failed:request_id'
  /** GDPR G1: current terms_privacy and age_16 consent are missing (checked first, after not_authenticated). */
  | 'consent_required';

// GDPR G1: legal versions and consents ---------------------------------------------------------

export type LegalDocumentKind = 'terms' | 'privacy';

/** Consent purposes. terms_privacy and age_16 cannot be withdrawn (not_withdrawable). */
export type ConsentPurpose =
  | 'terms_privacy'
  | 'age_16'
  | 'profile_demographics'
  | 'emergency_contact'
  | 'workout_logs'
  | 'push_notifications';

/** Result of `record_consent` / `withdraw_consent`. `changed` is false when nothing was written (idempotent). */
export type ConsentEvent = {
  purpose: ConsentPurpose;
  granted: boolean;
  /** terms_privacy: 'terms:<v>|privacy:<v>'; other purposes: the privacy version at the time. Null when never recorded. */
  document_version: string | null;
  at: string | null;
  changed: boolean;
};

/** Current state of one purpose in `my_consents`. */
export type ConsentState = {
  /** The latest event is a grant. */
  granted: boolean;
  /** granted and, for terms_privacy, of the current versions (what the server checks). */
  current: boolean;
  document_version: string | null;
  at: string | null;
};

/** Result of `my_consents`. */
export type MyConsents = {
  terms_version: string;
  terms_effective_at: string;
  privacy_version: string;
  privacy_effective_at: string;
  /** Pass verbatim as `p_document_version` of record_consent('terms_privacy', …). */
  terms_privacy_version: string;
  /** True unless terms_privacy is current and age_16 is granted. Show the first-launch screen when true. */
  needs_terms_acceptance: boolean;
  consents: Record<ConsentPurpose, ConsentState>;
};

/** Result of `admin_set_legal_version` (service_role only). */
export type AdminSetLegalVersionResult = {
  document: LegalDocumentKind;
  version: string;
  effective_at: string;
  changed: boolean;
};

/** Result of `preview_creator_code`. */
export type PreviewCreatorCodeResult = { ok: true } | { ok: false; error: CreatorCodeError };

/** Result of `create_community_with_code`. `already_created` is true for a replayed request id. */
export type CreateCommunityWithCodeResult =
  | { ok: true; community_id: string; membership_id: string; already_created: boolean }
  | { ok: false; error: CreateCommunityWithCodeError };

/** Result of `admin_create_creator_code` (service_role only). */
export type AdminCreateCreatorCodeResult = { code: string; expires_at: string; max_uses: number };

/** Result of `admin_revoke_creator_code` (service_role only). `changed` is false when already revoked. */
export type AdminRevokeCreatorCodeResult = {
  code: string;
  revoked_at: string;
  use_count: number;
  max_uses: number;
  changed: boolean;
};

/** One element of `list_my_communities`. */
export type MyCommunity = {
  community_id: string;
  membership_id: string;
  name: string;
  timezone: string;
  role: MembershipRole;
  joined_at: string;
};

/** Result of `set_rsvp`. */
export type SetRsvpResult = {
  response: RsvpResponse;
  going_count: number;
  status: SessionStatus;
};

/** One line of `get_attendance_sheet`. */
export type AttendanceSheetEntry = {
  user_id: string;
  display_name: string;
  /** null when the membership row no longer exists. */
  membership_status: MembershipStatus | null;
  rsvp_response: RsvpResponse;
  /** `unrecorded` when the member has no record yet. */
  attendance_status: AttendanceStatus;
  has_record: boolean;
  is_walk_in: boolean;
  /** null when the member has no record yet. */
  had_rsvp_going: boolean | null;
  /** Last status change; null when the member has no record yet. */
  updated_at: string | null;
};

/** Result of `get_attendance_sheet`. Entries are ordered by display name. */
export type AttendanceSheet = {
  session_id: string;
  status: SessionStatus;
  /** Server-side: the session's end (or start, without an end) has passed. */
  ended: boolean;
  attendance_finalized_at: string | null;
  attendance_finalized_by: string | null;
  entries: AttendanceSheetEntry[];
  /**
   * G2: anonymous records of deleted accounts (never listed as entries), by status. Always sent by
   * the server since 20261124000200; optional so cached / older payloads still type-check.
   */
  former_members?: { present: number; absent: number; unrecorded: number };
};

// GDPR G2: role management, export and deletion -------------------------------------------------

/** Result of `leave_community`. `changed` is false when the membership was already removed. */
export type LeaveCommunityResult = {
  community_id: string;
  membership_id: string;
  status: 'removed';
  changed: boolean;
  /** Open invitation codes revoked because nobody active is left in the community. */
  invitations_revoked: number;
};

/** A community where the caller is the last active organizer while other active members remain. */
export type DeletionBlocker = { community_id: string; name: string; active_members: number };

/** Result of `my_deletion_blockers`. */
export type MyDeletionBlockers = {
  can_delete: boolean;
  last_organizer: DeletionBlocker[];
  /** Communities where the caller is the last active member: deleted with the account. */
  deleted_with_account: { community_id: string; name: string }[];
};

/** JSON in the error `details` of `delete_my_account` when it raises `last_organizer`. */
export type DeletionBlockedDetail = { communities: DeletionBlocker[] };

/** Result of `delete_my_account`. */
export type DeleteMyAccountResult = {
  user_id: string;
  communities_deleted: string[];
  memberships_deleted: number;
  rsvps_deleted: number;
  attendance_records_anonymized: number;
  attendance_changes_anonymized: number;
  notifications_deleted: number;
};

/** Result of `export_my_data` (format_version 1). Lists hold at most 5000 items, oldest first. */
export type MyDataExport = {
  format_version: 1;
  generated_at: string;
  README: string;
  account: { user_id: string; created_at: string; is_anonymous: boolean };
  profile: { display_name: string; created_at: string; updated_at: string } | null;
  memberships: {
    membership_id: string;
    community_id: string;
    community_name: string;
    role: MembershipRole;
    status: MembershipStatus;
    joined_at: string;
  }[];
  rsvps: {
    rsvp_id: string;
    session_id: string;
    community_id: string;
    event_title: string;
    event_starts_at: string;
    event_status: SessionStatus;
    response: RsvpResponse;
    responded_at: string;
    updated_at: string;
  }[];
  attendance: {
    record_id: string;
    session_id: string;
    community_id: string;
    event_title: string;
    event_starts_at: string;
    status: AttendanceStatus;
    is_walk_in: boolean;
    had_rsvp_going: boolean;
    recorded_at: string;
    updated_at: string;
  }[];
  attendance_changes: {
    change_id: string;
    session_id: string;
    community_id: string;
    event_title: string;
    event_starts_at: string;
    old_status: AttendanceStatus;
    new_status: AttendanceStatus;
    action: AttendanceAuditAction;
    reason: string | null;
    changed_at: string;
    /** Never an organizer's name or id. */
    changed_by: 'you' | 'an organizer';
  }[];
  invitation_redemptions: {
    redemption_id: string;
    community_id: string;
    community_name: string;
    role: MembershipRole;
    redeemed_at: string;
  }[];
  creator_code_redemptions: {
    redemption_id: string;
    community_id: string;
    community_name: string;
    redeemed_at: string;
  }[];
  consents: {
    event_id: string;
    purpose: ConsentPurpose;
    granted: boolean;
    document_version: string | null;
    at: string;
  }[];
  /** null when never saved (all defaults on). */
  notification_preferences: {
    push_enabled: boolean;
    training_reminders: boolean;
    announcements: boolean;
    training_updates: boolean;
    updated_at: string;
  } | null;
  notifications: {
    notification_id: string;
    community_id: string;
    kind: NotificationKind;
    title: string;
    body: string;
    created_at: string;
    read_at: string | null;
    push_status: NotificationJobStatus | null;
    push_sent_at: string | null;
  }[];
  announcement_reads: {
    announcement_id: string;
    community_id: string;
    announcement_title: string;
    read_at: string;
  }[];
  /** P4: the caller's read cursors of event discussions. */
  event_feed_reads: {
    session_id: string;
    community_id: string;
    event_title: string;
    last_read_at: string;
  }[];
  /** Token values are never exported. */
  push_devices: {
    device_id: string;
    platform: PushPlatform;
    device_label: string | null;
    created_at: string;
    last_seen_at: string;
    invalidated_at: string | null;
  }[];
  authored: {
    announcements: {
      announcement_id: string;
      community_id: string;
      community_name: string;
      title: string;
      body: string;
      status: AnnouncementStatus;
      scheduled_for: string | null;
      published_at: string | null;
      created_at: string;
    }[];
    /** P4: the caller's event posts and replies; a deleted one has `body: null`. */
    event_posts: {
      post_id: string;
      session_id: string;
      community_id: string;
      community_name: string;
      event_title: string;
      parent_id: string | null;
      body: string | null;
      created_at: string;
      deleted_at: string | null;
    }[];
    events_organized: {
      session_id: string;
      community_id: string;
      community_name: string;
      title: string;
      starts_at: string;
      status: SessionStatus;
      created_at: string;
    }[];
    invitation_codes: {
      invitation_id: string;
      community_id: string;
      community_name: string;
      role: MembershipRole;
      created_at: string;
      expires_at: string | null;
      max_redemptions: number | null;
      redemption_count: number;
      revoked_at: string | null;
    }[];
    events_cancelled: number;
    events_attendance_finalized: number;
    attendance_records_created_for_others: number;
    attendance_changes_made_for_others: number;
  };
  technical: {
    invitation_attempts: { attempted_at: string; success: boolean }[];
    data_export_requests: { requested_at: string }[];
  };
  /** P3 (About you) and P5 (workout logs) add their sections here. */
  extensions: {
    /** P3: the caller's About-you details; null when none are stored. */
    about_you: {
      birth_year: number | null;
      gender: AboutYouGender | null;
      emergency_contact_name: string | null;
      emergency_contact_phone: string | null;
      emergency_contact_relationship: string | null;
      tshirt_size: TshirtSize | null;
      created_at: string;
      updated_at: string;
    } | null;
    /** P5: the caller's workout logs, oldest event first (absent in files exported before P5). */
    workout_logs?: (Omit<WorkoutLog, 'id'> & { log_id: string })[];
    /**
     * G3: when the app last recorded an app open, and a pending inactivity notice; null when
     * neither exists (absent in files exported before G3).
     */
    account_activity?: { last_app_open_at: string | null; inactivity_notice_at: string | null } | null;
  };
  /** true for a section that had more than 5000 items. */
  truncated: Record<
    | 'memberships'
    | 'rsvps'
    | 'attendance'
    | 'attendance_changes'
    | 'invitation_redemptions'
    | 'creator_code_redemptions'
    | 'consents'
    | 'notifications'
    | 'announcement_reads'
    | 'event_feed_reads'
    | 'push_devices'
    | 'authored_announcements'
    | 'event_posts'
    | 'events_organized'
    | 'invitation_codes'
    | 'invitation_attempts'
    | 'data_export_requests'
    | 'workout_logs',
    boolean
  >;
};

/** Keys shared by every event kind in `create_training` / `update_training`. */
type EventInputBase = {
  title: string;
  description?: string | null;
  starts_at: string;
  ends_at?: string | null;
  rsvp_deadline?: string | null;
  timezone?: string | null;
  location_name: string;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  map_url?: string | null;
  meeting_instructions?: string | null;
  max_participants?: number | null;
  /**
   * P1 optional keys. On update an ABSENT key keeps the stored value and null clears it.
   * distance_km (> 0, <= 1000, at most 2 decimals) and elevation_gain_m (0..20000) only for the
   * subtypes running, trail_running, asphalt_running, ocr; obstacle_count (0..500) only for ocr;
   * event_notes (<= 1000 characters) for every kind.
   */
  distance_km?: number | null;
  elevation_gain_m?: number | null;
  obstacle_count?: number | null;
  event_notes?: string | null;
};

/**
 * A training (P1 kind `training`, also the Milestone 1 payload without kind keys). The subtype
 * is `event_subtype`, or `activity_type` for older clients (both must agree when both are sent).
 */
export type TrainingEventInput = EventInputBase & {
  event_kind?: 'training' | null;
  event_subtype?: string | null;
  activity_type?: string | null;
  min_participants: number;
};

/**
 * A race, sports event or social event: no minimum (null or absent), created `confirmed`.
 * `event_subtype` must belong to the kind (a race has no default subtype). activity_type is
 * derived by the server and ignored when sent.
 */
export type OtherEventInput = EventInputBase & {
  event_kind: Exclude<EventKind, 'training'>;
  event_subtype?: string | null;
  min_participants?: null;
};

/**
 * `p_input` of `create_training` / `update_training`. Keys are the column
 * names. Timestamps are UTC ISO strings. The Milestone 1 keys are a full replace on update,
 * so the client sends every one of them. `event_kind` cannot change after creation.
 */
export type TrainingInput = TrainingEventInput | OtherEventInput;
/** P1 alias: "event" is the UI name of a training_sessions row. */
export type EventInput = TrainingInput;

// ---------------------------------------------------------------------------
// Milestone 4: statistics payloads (jsonb). Definitions: docs/STATS_DEFINITIONS.md.
// Timestamps are ISO strings. Rates are percentages with at most one decimal
// (rounded half up on the server) and null when their denominator is 0; the
// integer counts they come from are always returned beside them.
// ---------------------------------------------------------------------------

/** Time filter, measured back from the server's now() (N x 24 hours; `all` has no start). */
export type StatisticsWindow = '7d' | '30d' | '90d' | 'all';

/** Common envelope of every statistics payload. */
export type StatisticsEnvelope = {
  window: StatisticsWindow;
  /** Window start (inclusive); null for `all`. */
  from: string | null;
  /** Window end (inclusive) = the server's now() of the call. */
  to: string;
  generated_at: string;
};

/** One calendar month (community time zone) of a member's participation. */
export type MonthlyParticipation = {
  /** 'YYYY-MM' in the community time zone. */
  period: string;
  /** Bucket start / end instants (end exclusive). */
  from: string;
  to: string;
  eligible: number;
  attended: number;
  attendance_rate: number | null;
};

/** The member metrics shared by `get_my_statistics` and `get_member_statistics`. */
export type MemberStatisticsCounts = {
  /** |E|: finalized, non-cancelled sessions in the window the member was eligible for. */
  eligible: number;
  /** Present (walk-ins included). */
  attended: number;
  /** Explicitly marked absent. */
  absent: number;
  /** No record, or a record still `unrecorded`. Never counted as absent or missed. */
  not_recorded: number;
  /** attended + absent. */
  recorded: number;
  /** attended / eligible x 100. */
  attendance_rate: number | null;
  /** Sessions of E with a `going` RSVP. */
  confirmed_rsvps: number;
  /** Going and absent. */
  missed: number;
  /** Going and present (numerator of rsvp_reliability). */
  rsvp_going_present: number;
  /** Going with a recorded outcome, present or absent (denominator of rsvp_reliability). */
  rsvp_going_recorded: number;
  rsvp_reliability: number | null;
  /** Present as a walk-in. */
  walk_ins: number;
};

/** Result of `get_my_statistics` / `get_member_statistics`. */
export type MemberStatistics = StatisticsEnvelope &
  MemberStatisticsCounts & {
    /** The community's IANA time zone (buckets use it). */
    timezone: string;
    community_id: string;
    user_id: string;
    /** Current membership; organizers may read removed members. */
    membership_status: MembershipStatus;
    role: MembershipRole;
    joined_at: string;
    /** Every month of the window (for `all`: from the month of the first eligible session), empty ones included. */
    monthly: MonthlyParticipation[];
  };

/** Result of `get_my_statistics`. */
export type MyStatistics = MemberStatistics;

/** One session of `get_my_attendance_history` / `get_member_attendance_history`. */
export type AttendanceHistoryItem = {
  session_id: string;
  title: string;
  activity_type: string;
  /** P1. */
  event_kind: EventKind;
  /** P1. */
  event_subtype: string;
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  location_name: string;
  /** `no_response` when the member never answered. */
  rsvp_response: RsvpResponse;
  /** `unrecorded` = Not recorded (no record or never marked). */
  outcome: AttendanceStatus;
  is_walk_in: boolean;
};

/** Result of `get_my_attendance_history` / `get_member_attendance_history`: newest first. */
export type AttendanceHistoryPage = StatisticsEnvelope & {
  items: AttendanceHistoryItem[];
  has_more: boolean;
  /** Pass back verbatim as `p_before` for the next page; null on the last page. */
  next_before: string | null;
};

/** One bucket of the organizer attendance trend. */
export type AttendanceTrendBucket = {
  /** 'YYYY-MM-DD' (local Monday) for weeks, 'YYYY-MM' for months, community time zone. */
  period: string;
  from: string;
  to: string;
  sessions: number;
  present: number;
  /** Sessions of the bucket with no present / absent mark, excluded from the average. */
  incomplete_sessions: number;
  average_attendees: number | null;
};

/** One of the most attended trainings. */
export type TopSession = {
  session_id: string;
  title: string;
  starts_at: string;
  timezone: string;
  present: number;
  /** null for events other than trainings (P1). */
  min_participants: number | null;
  going_count: number;
  /** P1. */
  event_kind: EventKind;
};

/** Result of `get_community_statistics` (organizers). */
export type CommunityStatistics = StatisticsEnvelope & {
  timezone: string;
  community_id: string;
  /** |S|: finalized, non-cancelled sessions in the window. */
  completed_trainings: number;
  /** Present records over S (every real attendance, walk-ins and removed members included). */
  total_attendances: number;
  /** Present / sessions with at least one present or absent mark. */
  average_attendees: number | null;
  /** Sessions counted in average_attendees. */
  average_attendees_sessions: number;
  /** Sessions of S never marked (excluded from the average). */
  incomplete_sessions: number;
  /** Sum of going_count over S. */
  rsvp_going_total: number;
  /** rsvp_going_total / completed_trainings. */
  average_rsvp_participation: number | null;
  rsvp_going_present: number;
  rsvp_going_recorded: number;
  /** rsvp_going_present / rsvp_going_recorded x 100. */
  rsvp_conversion: number | null;
  /** Active memberships now (not windowed). */
  active_members: number;
  /** Active members with at least one attended eligible session in the window. */
  members_attended: number;
  cancelled_insufficient_participation: number;
  cancelled_by_organizer: number;
  /** 'week' for 7d / 30d, 'month' for 90d / all. */
  trend_unit: 'week' | 'month';
  trend: AttendanceTrendBucket[];
  /** At most 5, by present desc, newer first on ties. */
  top_sessions: TopSession[];
};

/** One line of `list_member_statistics_summary`. It carries no `recorded` (attended + absent). */
export type MemberStatisticsSummaryRow = Omit<MemberStatisticsCounts, 'recorded'> & {
  user_id: string;
  display_name: string;
  role: MembershipRole;
  joined_at: string;
};

/** Result of `list_member_statistics_summary` (organizers): active members by display name. */
export type MemberStatisticsSummary = StatisticsEnvelope & {
  community_id: string;
  /** All active members, also when the list is truncated. */
  total_members: number;
  /** True when more than 500 active members exist (only the first 500 are listed). */
  truncated: boolean;
  members: MemberStatisticsSummaryRow[];
};

// GDPR G3: retention of inactive accounts -------------------------------------------------------

/** Result of `record_app_open`. `notice` is the inactivity notice that was pending before the call (now ended). */
export type AppOpenResult = {
  inactivity_erasure_enabled: boolean;
  inactive_after_months: 24;
  notice_days: 30;
  notice: { noticed_at: string; erase_after: string } | null;
};

/** Result of `retention_preview` (service_role): counts only. */
export type RetentionPreview = {
  enabled: boolean;
  inactive_after_months: 24;
  notice_days: 30;
  generated_at: string;
  anonymous_accounts: number;
  inactive_accounts: number;
  inactive_without_notice: number;
  notices_pending: number;
  due_for_erasure: number;
  blocked_last_organizer: number;
  communities_deleted_with_due: number;
  communities_of_inactive_sole_members: number;
  last_run: RetentionRunLog | null;
};

/** One row of the retention run log (counts only). */
export type RetentionRunLog = {
  ran_at: string;
  notices_created: number;
  notices_cleared: number;
  accounts_erased: number;
  communities_deleted: number;
  blocked_last_organizer: number;
  deferred: number;
};

/** Result of `run_account_retention` (service_role). All zero and `enabled: false` while disabled. */
export type RetentionRunResult = Omit<RetentionRunLog, 'ran_at'> & {
  enabled: boolean;
  due_remaining: number;
};

/** Result of `admin_set_retention_enabled` (service_role). */
export type RetentionSwitchResult = { enabled: boolean; changed: boolean; notices_cleared: number };
