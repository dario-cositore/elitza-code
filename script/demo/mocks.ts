/**
 * Local endpoints for the demo recording.
 *
 * Google Places and Resend answer here so the recording shows the real
 * client_scout / outreach send code paths without any live account, key or
 * network call. record.sh points GOOGLE_PLACES_URL and RESEND_URL at it.
 */

const PLACES = {
  places: [
    {
      displayName: { text: "Studio Dentale Rossi" },
      formattedAddress: "Via Roma 1, 26022 Castelleone CR, Italy",
      nationalPhoneNumber: "+39 0374 123456",
      websiteUri: "https://studio-rossi.example",
      rating: 4.7,
      userRatingCount: 89,
      primaryType: "dentist",
      primaryTypeDisplayName: { text: "Dentist" },
      googleMapsUri: "https://maps.example/studio-rossi",
    },
    {
      displayName: { text: "Studio Dentale Bianchi" },
      formattedAddress: "Via Garibaldi 8, 26022 Castelleone CR, Italy",
      nationalPhoneNumber: "+39 0374 654321",
      websiteUri: "https://studio-bianchi.example",
      rating: 4.2,
      userRatingCount: 31,
      primaryType: "dentist",
      primaryTypeDisplayName: { text: "Dentist" },
      googleMapsUri: "https://maps.example/studio-bianchi",
    },
  ],
}

const port = Number(process.env.MOCK_PORT ?? 8791)

Bun.serve({
  port,
  fetch: (request) => {
    const { pathname } = new URL(request.url)
    if (pathname.endsWith("/places:searchText")) return Response.json(PLACES)
    if (pathname.endsWith("/emails")) return Response.json({ id: "email_demo_recording" })
    return Response.json({})
  },
})

console.log(`demo mocks listening on http://127.0.0.1:${port}`)
