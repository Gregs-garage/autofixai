// GET /api/vin?vin=<VIN>
// Decodes a VIN using the free NHTSA vPIC API and returns structured vehicle info.
// No auth required — VIN decode is a free public lookup.

import type { Config, Context } from '@netlify/functions'

const NHTSA_BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles'

export default async (req: Request, context: Context) => {
  const url = new URL(req.url)
  const vin = url.searchParams.get('vin')?.trim().toUpperCase()

  if (!vin) {
    return Response.json({ error: 'vin query parameter is required.' }, { status: 400 })
  }

  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return Response.json({ error: 'Invalid VIN format. Must be 17 alphanumeric characters.' }, { status: 400 })
  }

  try {
    const nhtsaRes = await fetch(
      `${NHTSA_BASE}/DecodeVinValues/${vin}?format=json`,
    )

    if (!nhtsaRes.ok) {
      return Response.json({ error: 'NHTSA lookup failed.' }, { status: 502 })
    }

    const data = (await nhtsaRes.json()) as {
      Results: Array<Record<string, string>>
    }

    const r = data.Results?.[0] ?? {}

    // Surface the fields the frontend uses
    const vehicle = {
      vin,
      year: r.ModelYear || null,
      make: r.Make || null,
      model: r.Model || null,
      trim: r.Trim || null,
      engine: r.DisplacementL
        ? `${r.DisplacementL}L ${r.EngineCylinders ? r.EngineCylinders + '-cyl' : ''}`.trim()
        : r.EngineModel || null,
      fuel_type: r.FuelTypePrimary || null,
      drive_type: r.DriveType || null,
      transmission: r.TransmissionStyle || null,
      body_class: r.BodyClass || null,
      plant_country: r.PlantCountry || null,
      error_code: r.ErrorCode || null,
      error_text: r.ErrorText || null,
    }

    return Response.json({ vehicle }, { status: 200 })
  } catch (err: any) {
    return Response.json({ error: err.message ?? 'VIN lookup failed.' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/vin',
  method: 'GET',
}
