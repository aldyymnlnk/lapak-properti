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
    description: 'Kos nyaman dan strategis di kawasan Soekarno Hatta Malang dengan akses cepat ke kampus, kuliner, dan transportasi umum.',
    specifications: {
      kos_type: 'Kos Putra/Putri',
      room_size: '3.5 x 4 m',
      bathroom: 'Kamar Mandi Dalam + Water Heater',
      electricity: 'Token Mandiri',
      facilities: 'AC, Wi-Fi, Parkir Motor, Dapur Bersama'
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
    description: 'Hunian 2 lantai di lingkungan mapan Sawojajar Malang dengan akses jalan lebar, pencahayaan alami, dan legalitas jelas.',
    specifications: {
      land_area: '120 m²',
      building_area: '145 m²',
      bedrooms: '3 Kamar Tidur',
      bathrooms: '2 Kamar Mandi',
      legality: 'SHM • IMB Lengkap',
      utilities: '2200W • PDAM',
      facilities: 'Carport 2 Mobil, Taman Depan, Ruang Keluarga Luas'
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
    description: 'Kavling tanah datar berhawa sejuk di jalur wisata Dau Malang, cocok untuk hunian pribadi, villa, maupun investasi.',
    specifications: {
      land_area: '200 m²',
      dimensions: '10 x 20 m',
      certificate: 'SHM (Sertifikat Hak Milik)',
      zoning: 'Zona Kuning',
      road_access: 'Paving 6 Meter',
      facilities: 'Akses Mobil Papasan, Udara Sejuk, Dekat Jalur Wisata'
    }
  }
];

export const GET: APIRoute = async ({ params, locals }) => {
  const id = String(params.id || '').trim();
  if (!id) {
    return jsonRes({ error: 'ID properti tidak valid' }, 400);
  }

  try {
    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from('properties')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (!error && data) {
      return jsonRes(data, 200);
    }
  } catch {
    // Fallback ke data contoh jika query Supabase gagal
  }

  const fallbackItem = FALLBACK_PROPERTIES.find((item) => item.id === id);
  if (fallbackItem) {
    return jsonRes(fallbackItem, 200);
  }

  return jsonRes({ error: 'Properti tidak ditemukan' }, 404);
};