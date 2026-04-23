import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Supabase credentials missing! Database sync will fail. Please add SUPABASE_URL and SUPABASE_ANON_KEY to your Settings -> Secrets.');
}

export const supabase = (supabaseUrl && supabaseKey) 
  ? createClient(supabaseUrl, supabaseKey)
  : { from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: { code: 'NO_CONFIG' } }) }) }), upsert: () => Promise.resolve({ error: { message: 'Supabase not configured' } }) }) } as any;

/**
 * SQL for Supabase Table Setup:
 * 
 * create table app_state (
 *   id text primary key,
 *   data jsonb not null default '{}'::jsonb,
 *   updated_at timestamp with time zone default now()
 * );
 * 
 * -- Enable Row Level Security (optional but recommended)
 * -- alter table app_state enable row level security;
 */

export const getDB = async () => {
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('data')
      .eq('id', 'global')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Table or row not found
        console.warn('[Supabase] Initial state not found, using defaults.');
        return null;
      }
      throw error;
    }
    return data?.data || null;
  } catch (err) {
    console.error('Error fetching from Supabase:', err);
    return null;
  }
};

export const syncDB = async (data: any) => {
  try {
    const { error } = await supabase
      .from('app_state')
      .upsert({ id: 'global', data }, { onConflict: 'id' });

    if (error) throw error;
  } catch (err: any) {
    console.error(`❌ Supabase Sync Error: ${err.message || err}`);
    throw err;
  }
};
