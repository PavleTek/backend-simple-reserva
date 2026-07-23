'use strict';

/**
 * Catálogo central de mensajes (es-CL).
 * El frontend solo renderiza; no inventa copy.
 */

function confidencePrefix(confidence) {
  if (confidence === 'high') return null;
  if (confidence === 'medium') return 'Durante las últimas semanas observamos que';
  return 'Parece que';
}

function withConfidence(confidence, strongSentence, softSentence) {
  if (confidence === 'high') return strongSentence;
  if (confidence === 'medium') {
    return softSentence || `Durante las últimas semanas observamos que ${strongSentence.charAt(0).toLowerCase()}${strongSentence.slice(1)}`;
  }
  return softSentence || `Parece que ${strongSentence.charAt(0).toLowerCase()}${strongSentence.slice(1)}`;
}

function missingLabel(key) {
  const map = {
    logo: 'logo',
    descripcion: 'descripción',
    direccion: 'dirección',
    contacto: 'teléfono o WhatsApp',
    menu: 'carta o menú',
  };
  return map[key] || key;
}

/**
 * @param {{ ruleId: string, confidence: string, payload: object, restaurantName?: string }} input
 */
function renderRecommendation(input) {
  const { ruleId, confidence, payload } = input;
  const p = payload || {};

  switch (ruleId) {
    case 'sin_horarios_activos':
      return {
        title: 'No hay horarios activos',
        explanation:
          'Detectamos que tu local no tiene días con horario de atención activo. Sin horarios, los clientes no pueden elegir una fecha para reservar.',
        action:
          'Configura al menos un día con horario de apertura en la sección Horarios.',
        whyShown:
          'Tu configuración actual no tiene ningún día de la semana con horario activo.',
        ctas: [{ type: 'navigate', label: 'Revisar horarios', path: '/settings/schedule' }],
      };

    case 'sin_mesas_activas':
      return {
        title: 'No hay mesas activas',
        explanation:
          'Detectamos que no tienes mesas activas. Sin mesas, SimpleReserva no puede ofrecer cupos en tu página de reservas.',
        action: 'Agrega o activa al menos una mesa en Zonas y mesas.',
        whyShown: 'El local no tiene mesas marcadas como activas.',
        ctas: [{ type: 'navigate', label: 'Configurar mesas', path: '/settings/zones-tables' }],
      };

    case 'proximos_dias_sin_cupos': {
      const blocked = p.cause === 'blocked';
      return {
        title: blocked
          ? 'Los próximos días están bloqueados'
          : 'No hay cupos disponibles en los próximos días',
        explanation: blocked
          ? 'Detectamos que los próximos días tienen la disponibilidad bloqueada. Mientras no haya cupos abiertos, los clientes no podrán reservar online.'
          : 'Detectamos que, con tu configuración actual, no hay horarios disponibles en los próximos días para los tamaños de grupo habituales de tu local.',
        action: blocked
          ? 'Revisa los cierres temporales y libera los días en los que quieras recibir reservas.'
          : 'Revisa tus horarios, mesas y políticas de anticipación para abrir cupos.',
        whyShown: blocked
          ? 'Hay bloqueos que cubren los próximos días.'
          : 'La disponibilidad calculada para los próximos días dio 0 cupos para los tamaños de grupo evaluados.',
        ctas: [
          blocked
            ? { type: 'navigate', label: 'Revisar cierres', path: '/settings/blocked-slots' }
            : { type: 'navigate', label: 'Revisar cupos', path: '/settings/availability' },
        ],
      };
    }

    case 'sin_reservas_online_recientes': {
      const variant = p.variant || 'generic';
      const manualNote =
        p.receivedManualLast7 > 0
          ? ` En ese mismo período registraste ${p.receivedManualLast7} reserva${p.receivedManualLast7 === 1 ? '' : 's'} manual${p.receivedManualLast7 === 1 ? '' : 'es'} desde el panel.`
          : '';

      if (variant === 'sin_cupos_visibles') {
        return {
          title: 'Hay visitas, pero poco cupo visible',
          explanation: `Detectamos visitas a tu página de reservas, pero en varios casos no se mostraron horarios disponibles. No recibiste reservas online en tus últimos días de apertura.${manualNote}`,
          action:
            'Revisa tu disponibilidad futura, cierres temporales y políticas de anticipación.',
          whyShown:
            'Hubo sesiones con page_view y una proporción alta de no_slots_shown, con 0 reservas online recibidas en los últimos 7 días.',
          ctas: [
            { type: 'navigate', label: 'Revisar disponibilidad', path: '/settings/availability' },
            { type: 'copy_link', label: 'Copiar enlace', url: p.publicBookingUrl },
          ],
        };
      }
      if (variant === 'abandono') {
        return {
          title: 'Hay visitas sin completar la reserva',
          explanation: `Detectamos visitas a tu página de reservas sin confirmaciones recientes. No recibiste reservas online en tus últimos días de apertura.${manualNote}`,
          action:
            'Revisa que tu página pública esté clara (datos del local, menú y contacto) y vuelve a compartir el enlace.',
          whyShown:
            'Hubo sesiones con page_view, cupos visibles y 0 confirmed en el funnel reciente.',
          ctas: [
            { type: 'navigate', label: 'Revisar perfil', path: '/settings/profile' },
            { type: 'copy_link', label: 'Copiar enlace', url: p.publicBookingUrl },
          ],
        };
      }
      // sin_trafico | generic
      return {
        title: 'Sin reservas online recientes',
        explanation: withConfidence(
          confidence,
          `No recibiste reservas online durante tus últimos ${p.recentOpenDaysWithCapacity || 'días'} de apertura.${manualNote} Revisar que el enlace esté visible puede ayudarte a recuperar visibilidad.`,
          `Parece que no recibiste reservas online en tus últimos días de apertura.${manualNote} Una forma de aumentar la exposición es revisar que el enlace esté visible en Instagram, Google y WhatsApp.`,
        ),
        action:
          'Revisa que tu enlace de SimpleReserva esté visible en Instagram, Google y WhatsApp. Puedes copiarlo y compartirlo nuevamente.',
        whyShown:
          'Hubo días de apertura efectiva con capacidad y 0 reservas online recibidas en los últimos 7 días.',
        ctas: [
          { type: 'copy_link', label: 'Copiar enlace', url: p.publicBookingUrl },
          { type: 'navigate', label: 'Ver página pública', path: p.publicBookingUrl, external: true },
        ],
      };
    }

    case 'caida_de_reservas':
      return {
        title: 'Bajaron las reservas recibidas',
        explanation: withConfidence(
          confidence,
          `Tus reservas recibidas bajaron respecto de tus últimas ${p.comparableWeeks} semanas comparables (mismo tipo de días de apertura).`,
          `Parece que tus reservas recibidas bajaron respecto de semanas anteriores comparables.`,
        ),
        action:
          'Revisa tu disponibilidad futura y considera recordarles a tus clientes que pueden reservar directamente desde tu enlace.',
        whyShown: `Última semana: ${p.lastWeekReceived} recibidas (${p.lastWeekReceivedPerOpenDay}/día abierto). Promedio comparable: ${p.baselineAvgReceived}/semana (${p.baselineAvgPerOpenDay}/día abierto). Caída: ${Math.round((p.dropRatio || 0) * 100)}%.`,
        ctas: [
          { type: 'copy_link', label: 'Copiar enlace', url: input.publicBookingUrl || p.publicBookingUrl },
          { type: 'navigate', label: 'Ver reservas', path: '/reservations' },
        ],
      };

    case 'ventana_futura_corta':
      return {
        title: 'Disponibilidad futura limitada',
        explanation: `Actualmente los clientes solo pueden reservar hasta ${p.advanceBookingLimitDays} día${p.advanceBookingLimitDays === 1 ? '' : 's'} hacia adelante. Ampliar esa ventana podría facilitar las reservas anticipadas.`,
        action: 'Revisa el límite de anticipación en Cupos y reservas.',
        whyShown: `advanceBookingLimitDays = ${p.advanceBookingLimitDays} (umbral ≤ ${p.threshold}).`,
        ctas: [{ type: 'navigate', label: 'Ampliar disponibilidad', path: '/settings/availability' }],
      };

    case 'aviso_minimo_alto':
      return {
        title: 'El aviso mínimo es muy alto',
        explanation: `Tu configuración exige al menos ${Math.round((p.minimumNoticeMinutes || 0) / 60)} horas de anticipación. Eso puede impedir reservas del mismo día.`,
        action: 'Revisa el aviso mínimo en Cupos y reservas si quieres permitir reservas más cercanas.',
        whyShown: `minimumNoticeMinutes = ${p.minimumNoticeMinutes} (umbral ≥ ${p.threshold}).`,
        ctas: [{ type: 'navigate', label: 'Revisar aviso mínimo', path: '/settings/availability' }],
      };

    case 'perfil_incompleto': {
      const missing = (p.missing || []).map(missingLabel);
      return {
        title: 'Tu página de reservas está incompleta',
        explanation: `Tu página pública todavía no tiene: ${missing.join(', ')}. Completar estos datos puede entregar mayor claridad antes de confirmar una reserva.`,
        action: 'Completa los datos faltantes en el perfil de tu local.',
        whyShown: `Campos faltantes: ${missing.join(', ')}.`,
        ctas: [{ type: 'navigate', label: 'Completar perfil', path: '/settings/profile' }],
      };
    }

    case 'sin_datos_contacto':
      return {
        title: 'No se piden datos de contacto',
        explanation:
          'Hoy no solicitas email ni teléfono al reservar. Sin esos datos, los recordatorios automáticos no pueden llegar al cliente.',
        action:
          'Activa la solicitud de email o teléfono en Cupos y reservas si quieres poder contactar y recordar a tus clientes.',
        whyShown: 'requireEmail y requirePhoneNumber están ambos desactivados.',
        ctas: [{ type: 'navigate', label: 'Revisar datos de contacto', path: '/settings/availability' }],
      };

    case 'dias_proximos_con_cupos':
      return {
        title: `Cupos disponibles el ${p.dayLabel || 'próximo día'}`,
        explanation: `El ${p.dayLabel || 'día'} ${p.dateLabel || ''} todavía tienes ${p.freeSlots} horario${p.freeSlots === 1 ? '' : 's'} disponible${p.freeSlots === 1 ? '' : 's'}. Podrías promocionar ese día en tus redes.`,
        action: 'Copia el enlace o un texto sugerido y compártelo donde te vean tus clientes.',
        whyShown: `Disponibilidad futura real: ${p.freeSlots} cupos libres el ${p.date}.`,
        ctas: [
          { type: 'copy_link', label: 'Copiar enlace', url: p.publicBookingUrl },
          {
            type: 'copy_text',
            label: 'Copiar texto para redes',
            text: p.promoText || '',
          },
        ],
      };

    case 'tendencia_positiva': {
      const top = p.topDay
        ? ` El ${p.topDay.dayLabel || 'día'} fue tu día con más reservas programadas.`
        : '';
      return {
        title: 'Buena semana de reservas recibidas',
        explanation: withConfidence(
          confidence,
          `Esta semana recibiste más reservas que en tus semanas anteriores comparables.${top}`,
          `Parece que esta semana recibiste más reservas que en semanas anteriores comparables.${top}`,
        ),
        action: 'Sigue compartiendo tu enlace y manteniendo tu disponibilidad al día.',
        whyShown: `Última semana: ${p.lastWeekReceived} recibidas (${p.lastWeekReceivedPerOpenDay}/día abierto). Crecimiento: ${Math.round((p.growthRatio || 0) * 100)}% vs promedio comparable.`,
        ctas: [{ type: 'navigate', label: 'Ver reservas', path: '/reservations' }],
      };
    }

    default:
      return {
        title: 'Sugerencia',
        explanation: 'Hay una sugerencia disponible para tu local.',
        action: 'Revisa los detalles en Sugerencias.',
        whyShown: `Regla: ${ruleId}`,
        ctas: [{ type: 'navigate', label: 'Ver sugerencias', path: '/sugerencias' }],
      };
  }
}

function buildChecklistPresentation(checklist, publicBookingUrl) {
  const items = [
    {
      id: 'onboarding',
      label: 'Completar la configuración inicial',
      done: Boolean(checklist.onboardingComplete),
      path: null,
    },
    {
      id: 'profile',
      label: 'Completar el perfil del local',
      done: Boolean(checklist.profileComplete),
      path: '/settings/profile',
    },
    {
      id: 'schedule',
      label: 'Verificar horarios de atención',
      done: Boolean(checklist.hasSchedule),
      path: '/settings/schedule',
    },
    {
      id: 'tables',
      label: 'Configurar mesas y capacidad',
      done: Boolean(checklist.hasTables),
      path: '/settings/zones-tables',
    },
    {
      id: 'public',
      label: 'Revisar la página pública',
      done: Boolean(checklist.hasPublicPage),
      path: publicBookingUrl,
      external: true,
    },
    {
      id: 'share',
      label: 'Copiar y compartir el enlace de reservas',
      done: Boolean(checklist.hasOnlineReservation),
      path: null,
      copyLink: publicBookingUrl,
    },
    {
      id: 'first_online',
      label: 'Recibir la primera reserva online',
      done: Boolean(checklist.hasOnlineReservation),
      path: null,
    },
  ];

  return {
    title: 'Primeros pasos para tu local',
    message:
      'Cuando recibas más reservas, comenzaremos a mostrarte patrones y oportunidades específicas de tu local.',
    items,
  };
}

module.exports = {
  renderRecommendation,
  buildChecklistPresentation,
  confidencePrefix,
};
