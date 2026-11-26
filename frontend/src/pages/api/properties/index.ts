import type { APIRoute } from 'astro';
import { getSupabase, jsonRes } from '../../../lib/apiServer';

const FALLBACK_PROPERTIES = [
  {
    id: 'demo-kos-soekarno-hatta',
    title: 'Kos Eksklusif Griya Suhat Malang',
    category: 'kos',
    location: 'Jl. Soekarno Hatta, Lowokwaru, Kota Malang',
    block_or_unit: 'Kamar A-04',
    price: 1350000,
    price_unit: 'bulan',
    status: 'AVAILABLE',
    image_url: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=900&q=80',
    specifications: {
      kos_type: 'Kos Putra/Putri',
      bathroom: 'Kamar Mandi Dalam + Water Heater',
      facilities: ['AC', 'Wi-Fi', 'Parkir Motor', 'Dapur Bersama']
    }
  },
  {
    id: 'demo-rumah-sawojajar',
    title: 'Rumah Minimalis 2 Lantai Sawojajar',
    category: 'rumah',
    location: 'Sawojajar, Kedungkandang, Kota Malang',
    block_or_unit: 'Kavling B-12',
    price: 850000000,
    price_unit: 'unit',
    status: 'AVAILABLE',
    image_url: 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=900&q=80',
    specifications: {
      land_area: '120 m²',
      bedrooms: '3 Kamar Tidur',
      legality: 'SHM • IMB Lengkap'
    }
  },
  {
    id: 'demo-tanah-dau',
    title: 'Kavling Tanah Strategis Jalur Wisata Dau',
    category: 'tanah',
    location: 'Dau, Kabupaten Malang',
    block_or_unit: 'Kavling C-07',
    price: 375000000,
    price_unit: 'kavling',
    status: 'AVAILABLE',
    image_url: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=900&q=80',
    specifications: {
      land_area: '200 m²',
      certificate: 'SHM (Sertifikat Hak Milik)'
    }
  }
];

export const GET: APIRoute = async ({ locals }) => {
  try {
    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from('properties')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && Array.isArray(data) && data.length > 0) {
      return jsonRes(data, 200);
    }

    return jsonRes(FALLBACK_PROPERTIES, 200);
  } catch {
    return jsonRes(FALLBACK_PROPERTIES, 200);
  }
};