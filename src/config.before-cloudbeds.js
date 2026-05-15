export const CONFIG = {
  timezone: 'America/Mexico_City',
  currency: 'MXN',
  nights: 1,
  adults: 2,
  children: 0,
  daysToScan: 30,
  discrepancyPctAlert: 12,
  hotels: {
    hm: {
      name: 'Hotel Marielena',
      engine: 'direct-book',
      urlForDate: (checkIn, checkOut) =>
        `https://direct-book.com/properties/hotelmarielenadirect?checkInDate=${checkIn}&checkOutDate=${checkOut}&currency=MXN&items%5B0%5D%5Badults%5D=2&items%5B0%5D%5Bchildren%5D=0&items%5B0%5D%5Binfants%5D=0&locale=es&trackPage=yes`,
      roomAliases: {
        'Suite Patio King': ['Suite Patio King', 'Patio King', '1 cama king', 'King'],
        'Suite Patio Doble': ['Suite Patio Doble', 'Patio Doble', '2 camas matrimoniales', 'Doble'],
        'Suite Standard Doble': ['Suite Standard Doble', 'Standard Suite', 'Standar Suite', '2 camas matrimoniales'],
        'Jr Suite': ['Jr Suite', 'Junior Suite'],
        'Master Suite': ['Master Suite', 'Suite Master'],
        'Handicap': ['Handicap', 'Accesible', 'silla de ruedas']
      }
    },
    h1800: {
      name: 'Hacienda 1800',
      engine: 'omnibees',
      urlForDate: (checkIn, checkOut) => {
        const fmt = (d) => d.replace(/-/g, '').slice(6) + d.replace(/-/g, '').slice(4,6) + d.replace(/-/g, '').slice(0,4);
        const ci = fmt(checkIn);
        const co = fmt(checkOut);
        return `https://book.omnibees.com/hotelresults?c=9446&q=17650&currencyId=66&lang=es-ES&NRooms=1&CheckIn=${ci}&CheckOut=${co}&ad=2&ch=0`;
      }
    }
  }
};
