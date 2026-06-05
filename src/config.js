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
      engine: 'cloudbeds',
      urlForDate: (checkIn, checkOut) =>
        `https://us2.cloudbeds.com/es/reservation/Vk867F/?currency=mxn&checkin=${checkIn}&checkout=${checkOut}`,
      roomAliases: {
        'Suite Patio King': ['Suite Patio King', 'Patio King'],
        'Suite Patio Doble': ['Suite Patio Doble', 'Patio Doble'],
        'Suite Standard Doble': ['Suite Standard Doble', 'Standard Doble', 'Suite Standard'],
        'Jr Suite': ['Jr Suite', 'Junior Suite', 'Suite Junior'],
        'Master Suite': ['Master Suite', 'Suite Master'],
        'Handicap': ['Handicap', 'Handicapped', 'Accesible']
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
