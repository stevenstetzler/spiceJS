/**
 * NAIF's built-in *body-fixed* (class 2 / PCK) reference frames --
 * IAU_MOON, IAU_EARTH, IAU_MARS, ... -- extracted directly from NAIF's
 * own source (zzfdat.c in the OpenSpace/Spice mirror of CSPICE) by
 * scripts/extract-body-fixed-frames.mjs -- not hand-transcribed. Do
 * not edit by hand; re-run that script instead.
 *
 * Each entry's `classId` is the lookup key used to find this frame's
 * orientation data -- either a loaded binary PCK segment whose frame
 * ID equals `classId`, or (falling back, per NAIF's documented
 * priority) a loaded text PCK's `BODY<classId>_POLE_RA/DEC/PM`
 * constants. For every one of these built-in frames, `classId` is
 * simply the NAIF body ID the frame is fixed to (e.g. IAU_MOON's
 * `classId` is 301) -- see src/frames.js and src/bodyOrientation.js.
 *
 * The 21 built-in *inertial* frames (J2000, ...) are a separate table
 * -- see src/data/inertialFrames.js / extract-inertial-frames.mjs.
 */
export const BODY_FIXED_FRAMES = [
  {
    "id": 10001,
    "name": "IAU_MERCURY_BARYCENTER",
    "classId": 1
  },
  {
    "id": 10002,
    "name": "IAU_VENUS_BARYCENTER",
    "classId": 2
  },
  {
    "id": 10003,
    "name": "IAU_EARTH_BARYCENTER",
    "classId": 3
  },
  {
    "id": 10004,
    "name": "IAU_MARS_BARYCENTER",
    "classId": 4
  },
  {
    "id": 10005,
    "name": "IAU_JUPITER_BARYCENTER",
    "classId": 5
  },
  {
    "id": 10006,
    "name": "IAU_SATURN_BARYCENTER",
    "classId": 6
  },
  {
    "id": 10007,
    "name": "IAU_URANUS_BARYCENTER",
    "classId": 7
  },
  {
    "id": 10008,
    "name": "IAU_NEPTUNE_BARYCENTER",
    "classId": 8
  },
  {
    "id": 10009,
    "name": "IAU_PLUTO_BARYCENTER",
    "classId": 9
  },
  {
    "id": 10010,
    "name": "IAU_SUN",
    "classId": 10
  },
  {
    "id": 10011,
    "name": "IAU_MERCURY",
    "classId": 199
  },
  {
    "id": 10012,
    "name": "IAU_VENUS",
    "classId": 299
  },
  {
    "id": 10013,
    "name": "IAU_EARTH",
    "classId": 399
  },
  {
    "id": 10014,
    "name": "IAU_MARS",
    "classId": 499
  },
  {
    "id": 10015,
    "name": "IAU_JUPITER",
    "classId": 599
  },
  {
    "id": 10016,
    "name": "IAU_SATURN",
    "classId": 699
  },
  {
    "id": 10017,
    "name": "IAU_URANUS",
    "classId": 799
  },
  {
    "id": 10018,
    "name": "IAU_NEPTUNE",
    "classId": 899
  },
  {
    "id": 10019,
    "name": "IAU_PLUTO",
    "classId": 999
  },
  {
    "id": 10020,
    "name": "IAU_MOON",
    "classId": 301
  },
  {
    "id": 10021,
    "name": "IAU_PHOBOS",
    "classId": 401
  },
  {
    "id": 10022,
    "name": "IAU_DEIMOS",
    "classId": 402
  },
  {
    "id": 10023,
    "name": "IAU_IO",
    "classId": 501
  },
  {
    "id": 10024,
    "name": "IAU_EUROPA",
    "classId": 502
  },
  {
    "id": 10025,
    "name": "IAU_GANYMEDE",
    "classId": 503
  },
  {
    "id": 10026,
    "name": "IAU_CALLISTO",
    "classId": 504
  },
  {
    "id": 10027,
    "name": "IAU_AMALTHEA",
    "classId": 505
  },
  {
    "id": 10028,
    "name": "IAU_HIMALIA",
    "classId": 506
  },
  {
    "id": 10029,
    "name": "IAU_ELARA",
    "classId": 507
  },
  {
    "id": 10030,
    "name": "IAU_PASIPHAE",
    "classId": 508
  },
  {
    "id": 10031,
    "name": "IAU_SINOPE",
    "classId": 509
  },
  {
    "id": 10032,
    "name": "IAU_LYSITHEA",
    "classId": 510
  },
  {
    "id": 10033,
    "name": "IAU_CARME",
    "classId": 511
  },
  {
    "id": 10034,
    "name": "IAU_ANANKE",
    "classId": 512
  },
  {
    "id": 10035,
    "name": "IAU_LEDA",
    "classId": 513
  },
  {
    "id": 10036,
    "name": "IAU_THEBE",
    "classId": 514
  },
  {
    "id": 10037,
    "name": "IAU_ADRASTEA",
    "classId": 515
  },
  {
    "id": 10038,
    "name": "IAU_METIS",
    "classId": 516
  },
  {
    "id": 10039,
    "name": "IAU_MIMAS",
    "classId": 601
  },
  {
    "id": 10040,
    "name": "IAU_ENCELADUS",
    "classId": 602
  },
  {
    "id": 10041,
    "name": "IAU_TETHYS",
    "classId": 603
  },
  {
    "id": 10042,
    "name": "IAU_DIONE",
    "classId": 604
  },
  {
    "id": 10043,
    "name": "IAU_RHEA",
    "classId": 605
  },
  {
    "id": 10044,
    "name": "IAU_TITAN",
    "classId": 606
  },
  {
    "id": 10045,
    "name": "IAU_HYPERION",
    "classId": 607
  },
  {
    "id": 10046,
    "name": "IAU_IAPETUS",
    "classId": 608
  },
  {
    "id": 10047,
    "name": "IAU_PHOEBE",
    "classId": 609
  },
  {
    "id": 10048,
    "name": "IAU_JANUS",
    "classId": 610
  },
  {
    "id": 10049,
    "name": "IAU_EPIMETHEUS",
    "classId": 611
  },
  {
    "id": 10050,
    "name": "IAU_HELENE",
    "classId": 612
  },
  {
    "id": 10051,
    "name": "IAU_TELESTO",
    "classId": 613
  },
  {
    "id": 10052,
    "name": "IAU_CALYPSO",
    "classId": 614
  },
  {
    "id": 10053,
    "name": "IAU_ATLAS",
    "classId": 615
  },
  {
    "id": 10054,
    "name": "IAU_PROMETHEUS",
    "classId": 616
  },
  {
    "id": 10055,
    "name": "IAU_PANDORA",
    "classId": 617
  },
  {
    "id": 10056,
    "name": "IAU_ARIEL",
    "classId": 701
  },
  {
    "id": 10057,
    "name": "IAU_UMBRIEL",
    "classId": 702
  },
  {
    "id": 10058,
    "name": "IAU_TITANIA",
    "classId": 703
  },
  {
    "id": 10059,
    "name": "IAU_OBERON",
    "classId": 704
  },
  {
    "id": 10060,
    "name": "IAU_MIRANDA",
    "classId": 705
  },
  {
    "id": 10061,
    "name": "IAU_CORDELIA",
    "classId": 706
  },
  {
    "id": 10062,
    "name": "IAU_OPHELIA",
    "classId": 707
  },
  {
    "id": 10063,
    "name": "IAU_BIANCA",
    "classId": 708
  },
  {
    "id": 10064,
    "name": "IAU_CRESSIDA",
    "classId": 709
  },
  {
    "id": 10065,
    "name": "IAU_DESDEMONA",
    "classId": 710
  },
  {
    "id": 10066,
    "name": "IAU_JULIET",
    "classId": 711
  },
  {
    "id": 10067,
    "name": "IAU_PORTIA",
    "classId": 712
  },
  {
    "id": 10068,
    "name": "IAU_ROSALIND",
    "classId": 713
  },
  {
    "id": 10069,
    "name": "IAU_BELINDA",
    "classId": 714
  },
  {
    "id": 10070,
    "name": "IAU_PUCK",
    "classId": 715
  },
  {
    "id": 10071,
    "name": "IAU_TRITON",
    "classId": 801
  },
  {
    "id": 10072,
    "name": "IAU_NEREID",
    "classId": 802
  },
  {
    "id": 10073,
    "name": "IAU_NAIAD",
    "classId": 803
  },
  {
    "id": 10074,
    "name": "IAU_THALASSA",
    "classId": 804
  },
  {
    "id": 10075,
    "name": "IAU_DESPINA",
    "classId": 805
  },
  {
    "id": 10076,
    "name": "IAU_GALATEA",
    "classId": 806
  },
  {
    "id": 10077,
    "name": "IAU_LARISSA",
    "classId": 807
  },
  {
    "id": 10078,
    "name": "IAU_PROTEUS",
    "classId": 808
  },
  {
    "id": 10079,
    "name": "IAU_CHARON",
    "classId": 901
  },
  {
    "id": 13000,
    "name": "ITRF93",
    "classId": 3000
  },
  {
    "id": 10082,
    "name": "IAU_PAN",
    "classId": 618
  },
  {
    "id": 10083,
    "name": "IAU_GASPRA",
    "classId": 9511010
  },
  {
    "id": 10084,
    "name": "IAU_IDA",
    "classId": 2431010
  },
  {
    "id": 10085,
    "name": "IAU_EROS",
    "classId": 2000433
  },
  {
    "id": 10086,
    "name": "IAU_CALLIRRHOE",
    "classId": 517
  },
  {
    "id": 10087,
    "name": "IAU_THEMISTO",
    "classId": 518
  },
  {
    "id": 10088,
    "name": "IAU_MEGACLITE",
    "classId": 519
  },
  {
    "id": 10089,
    "name": "IAU_TAYGETE",
    "classId": 520
  },
  {
    "id": 10090,
    "name": "IAU_CHALDENE",
    "classId": 521
  },
  {
    "id": 10091,
    "name": "IAU_HARPALYKE",
    "classId": 522
  },
  {
    "id": 10092,
    "name": "IAU_KALYKE",
    "classId": 523
  },
  {
    "id": 10093,
    "name": "IAU_IOCASTE",
    "classId": 524
  },
  {
    "id": 10094,
    "name": "IAU_ERINOME",
    "classId": 525
  },
  {
    "id": 10095,
    "name": "IAU_ISONOE",
    "classId": 526
  },
  {
    "id": 10096,
    "name": "IAU_PRAXIDIKE",
    "classId": 527
  },
  {
    "id": 10097,
    "name": "IAU_BORRELLY",
    "classId": 1000005
  },
  {
    "id": 10098,
    "name": "IAU_TEMPEL_1",
    "classId": 1000093
  },
  {
    "id": 10099,
    "name": "IAU_VESTA",
    "classId": 2000004
  },
  {
    "id": 10100,
    "name": "IAU_ITOKAWA",
    "classId": 2025143
  },
  {
    "id": 10101,
    "name": "IAU_CERES",
    "classId": 2000001
  },
  {
    "id": 10102,
    "name": "IAU_PALLAS",
    "classId": 2000002
  },
  {
    "id": 10103,
    "name": "IAU_LUTETIA",
    "classId": 2000021
  },
  {
    "id": 10104,
    "name": "IAU_DAVIDA",
    "classId": 2000511
  },
  {
    "id": 10105,
    "name": "IAU_STEINS",
    "classId": 2002867
  },
  {
    "id": 10106,
    "name": "IAU_BENNU",
    "classId": 2101955
  },
  {
    "id": 10107,
    "name": "IAU_52_EUROPA",
    "classId": 2000052
  },
  {
    "id": 10108,
    "name": "IAU_NIX",
    "classId": 902
  },
  {
    "id": 10109,
    "name": "IAU_HYDRA",
    "classId": 903
  },
  {
    "id": 10110,
    "name": "IAU_RYUGU",
    "classId": 2162173
  },
  {
    "id": 10111,
    "name": "IAU_ARROKOTH",
    "classId": 2486958
  },
  {
    "id": 10112,
    "name": "IAU_DIDYMOS_BARYCENTER",
    "classId": 20065803
  },
  {
    "id": 10113,
    "name": "IAU_DIDYMOS",
    "classId": 920065803
  },
  {
    "id": 10114,
    "name": "IAU_DIMORPHOS",
    "classId": 120065803
  },
  {
    "id": 10115,
    "name": "IAU_DONALDJOHANSON",
    "classId": 20052246
  },
  {
    "id": 10116,
    "name": "IAU_EURYBATES",
    "classId": 920003548
  },
  {
    "id": 10117,
    "name": "IAU_EURYBATES_BARYCENTER",
    "classId": 20003548
  },
  {
    "id": 10118,
    "name": "IAU_QUETA",
    "classId": 120003548
  },
  {
    "id": 10119,
    "name": "IAU_POLYMELE",
    "classId": 20015094
  },
  {
    "id": 10120,
    "name": "IAU_LEUCUS",
    "classId": 20011351
  },
  {
    "id": 10121,
    "name": "IAU_ORUS",
    "classId": 20021900
  },
  {
    "id": 10122,
    "name": "IAU_PATROCLUS_BARYCENTER",
    "classId": 20000617
  },
  {
    "id": 10123,
    "name": "IAU_PATROCLUS",
    "classId": 920000617
  },
  {
    "id": 10124,
    "name": "IAU_MENOETIUS",
    "classId": 120000617
  }
];
