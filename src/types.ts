export interface ThreadsUser {
  pk: number | string;
  id?: string;
  username: string;
  full_name: string;
  is_verified: boolean;
  is_private: boolean;
  profile_pic_url: string;
  biography?: string;
  follower_count?: number;
  following_count?: number;
  media_count?: number;
  external_url?: string | null;
  hd_profile_pic_url_info?: { url: string; width?: number; height?: number };
  text_post_app_is_private?: boolean;
  [key: string]: unknown;
}

export interface ThreadsText {
  text: string;
}

export interface ThreadItemPost {
  pk?: string | number;
  id?: string;
  code?: string;
  user?: ThreadsUser;
  caption?: ThreadsText | null;
  taken_at?: number;
  like_count?: number;
  media_type?: number;
  image_versions2?: {
    candidates?: Array<{ url: string; width?: number; height?: number }>;
  };
  video_versions?: Array<{ url: string; type?: number; width?: number; height?: number }>;
  text_post_app_info?: {
    reply_count?: number;
    repost_count?: number;
    quote_count?: number;
    direct_reply_count?: number;
    is_post_unavailable?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ThreadItem {
  post: ThreadItemPost;
  line_type?: string;
  view_replies_cta_string?: string;
  [key: string]: unknown;
}

export interface Thread {
  id?: string;
  thread_items: ThreadItem[];
  thread_type?: string;
  [key: string]: unknown;
}

export interface WebProfileUser {
  id: string;
  username: string;
  full_name: string;
  biography: string;
  profile_pic_url: string;
  profile_pic_url_hd?: string;
  is_verified: boolean;
  is_private: boolean;
  external_url?: string | null;
  edge_followed_by: { count: number };
  edge_follow: { count: number };
  edge_owner_to_timeline_media?: { count: number; edges?: unknown[] };
  fbid?: string;
  eimu_id?: string;
  [key: string]: unknown;
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; severity?: string; code?: number; [key: string]: unknown }>;
  extensions?: Record<string, unknown>;
}

export interface DocIdMap {
  [operationName: string]: string;
}

export type ReplyControl = 'everyone' | 'accounts_you_follow' | 'mentioned_only';

export const REPLY_CONTROL_OPTIONS: Record<ReplyControl, number> = {
  everyone: 0,
  accounts_you_follow: 1,
  mentioned_only: 2,
};
